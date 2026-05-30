/**
 * Tests for the subscription pub/sub primitive and the persistent
 * transformation triggers (`never`/`once`/`always`).
 */

import { describe, it, expect } from 'test-anywhere';
import { Database } from '../src/query.js';
import { Subscriptions, Triggers, TriggerError } from '../src/triggers.js';

describe('Subscriptions', () => {
  it('notifies subscribers about matching changes', () => {
    const db = new Database();
    const subs = new Subscriptions(db);
    const events = [];
    subs.subscribe('((1 $x))', (event) => events.push(event));

    db.query('() ((1 2))');
    expect(events.length).toBe(1);
    expect(events[0].operation).toBe('create');
    expect(events[0].matching.length).toBe(1);
  });

  it('ignores changes that do not match the pattern', () => {
    const db = new Database();
    const subs = new Subscriptions(db);
    const events = [];
    subs.subscribe('((1 $x))', (event) => events.push(event));

    db.query('() ((9 9))');
    expect(events.length).toBe(0);
  });

  it('treats an empty restriction as "everything"', () => {
    const db = new Database();
    const subs = new Subscriptions(db);
    let count = 0;
    subs.subscribe('()', () => {
      count += 1;
    });

    db.query('() ((7 8))');
    expect(count).toBe(1);
  });

  it('stops notifying after unsubscribe', () => {
    const db = new Database();
    const subs = new Subscriptions(db);
    const events = [];
    const unsubscribe = subs.subscribe('((1 $x))', (event) =>
      events.push(event)
    );

    db.query('() ((1 2))');
    unsubscribe();
    db.query('() ((1 5))');
    expect(events.length).toBe(1);
  });
});

describe('Triggers', () => {
  it('rejects unknown modes', () => {
    const db = new Database();
    const triggers = new Triggers(db);
    expect(() => triggers.add('() ((1 1))', { mode: 'sometimes' })).toThrow(
      TriggerError
    );
  });

  it('once: applies the substitution exactly one time', () => {
    const db = new Database();
    db.query('() ((1 2))');
    const triggers = new Triggers(db);
    const rule = triggers.add('((1 2)) ()', { mode: 'once' });

    expect(rule.fired).toBe(1);
    expect(db.count()).toBe(0);

    // Re-introducing the link must not re-fire a one-shot rule.
    db.query('() ((1 2))');
    expect(db.count()).toBe(1);
    expect(rule.fired).toBe(1);
  });

  it('always: keeps a standing rule applied across later changes', () => {
    const db = new Database();
    db.query('() ((1 2))');
    const triggers = new Triggers(db);
    triggers.add('((1 2)) ()', { mode: 'always' });

    // Installed immediately on the existing link.
    expect(db.store.findByPair(1, 2)).toBeUndefined();
    expect(db.count()).toBe(0);

    // A later external creation is undone by the standing rule.
    db.query('() ((1 2))');
    expect(db.store.findByPair(1, 2)).toBeUndefined();
    expect(db.count()).toBe(0);
  });

  it('always: drives a transformation to a fixpoint', () => {
    const db = new Database();
    db.query('() ((1 2))');
    const triggers = new Triggers(db);
    // Rewrite (1 -> 2) into (1 -> 3); afterwards nothing matches (1 -> 2).
    triggers.add('((1 2)) ((1 3))', { mode: 'always' });

    expect(db.store.findByPair(1, 2)).toBeUndefined();
    expect(db.store.findByPair(1, 3)).not.toBeUndefined();
    expect(db.count()).toBe(1);
  });

  it('never: reports matches without mutating, and re-reads on change', () => {
    const db = new Database();
    db.query('() ((1 2))');
    const triggers = new Triggers(db);
    const reports = [];
    const rule = triggers.add('((1 2))', {
      mode: 'never',
      onFire: (report) => reports.push(report),
    });

    expect(rule.fired).toBe(1);
    expect(reports[0].operation).toBe('read');
    expect(reports[0].matched.length).toBe(1);
    expect(db.count()).toBe(1);

    // An unrelated change re-runs the read-only watch.
    db.query('() ((3 4))');
    expect(rule.fired).toBe(2);
    expect(db.count()).toBe(2);
  });

  it('aborts a rule that never stabilises', () => {
    const db = new Database();
    db.query('() ((1 2))');
    const triggers = new Triggers(db, { maxIterations: 5 });
    // Swapping source/target forever oscillates and never reaches a fixpoint.
    expect(() =>
      triggers.add('(($i: $s $t)) (($i: $t $s))', { mode: 'always' })
    ).toThrow(TriggerError);
  });

  it('remove uninstalls a standing rule', () => {
    const db = new Database();
    const triggers = new Triggers(db);
    const rule = triggers.add('((1 2)) ()', { mode: 'always' });
    expect(triggers.size).toBe(1);
    expect(triggers.remove(rule)).toBe(true);
    expect(triggers.size).toBe(0);

    // With the rule gone, the link survives.
    db.query('() ((1 2))');
    expect(db.count()).toBe(1);
  });
});
