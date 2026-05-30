/**
 * Tests for the store, the substitution engine and the query executor — the
 * heart of LinksQL. The CRUD examples mirror the canonical operations from the
 * specification.
 */

import { describe, it, expect } from 'test-anywhere';
import { LinksStore, LinkIntegrityError } from '../src/store.js';
import { Names, UnknownNameError } from '../src/names.js';
import { Database, splitQuery, linkToLino } from '../src/query.js';
import { parse } from '../src/lino.js';

describe('LinksStore', () => {
  it('creates and deduplicates by (source, target)', () => {
    const store = new LinksStore();
    const a = store.create({ source: 1, target: 1 });
    const b = store.create({ source: 1, target: 1 });
    expect(a.index).toBe(b.index);
    expect(store.size).toBe(1);
  });

  it('allocates fresh identities that skip used ones', () => {
    const store = new LinksStore();
    store.create({ index: 1, source: 1, target: 1 });
    const next = store.create({ source: 2, target: 3 });
    expect(next.index).toBe(2);
  });

  it('rejects conflicting explicit identities', () => {
    const store = new LinksStore();
    store.create({ index: 5, source: 1, target: 2 });
    expect(() => store.create({ index: 6, source: 1, target: 2 })).toThrow();
  });

  it('updates structure while keeping identity', () => {
    const store = new LinksStore();
    const link = store.create({ source: 1, target: 1 });
    const updated = store.update(link.index, { source: 1, target: 2 });
    expect(updated.index).toBe(link.index);
    expect(updated.target).toBe(2);
    expect(store.findByPair(1, 1)).toBeUndefined();
  });

  it('throws on integrity violations', () => {
    const store = new LinksStore();
    expect(() => store.update(99, { source: 1, target: 1 })).toThrow(
      LinkIntegrityError
    );
  });
});

describe('Database CRUD via the single substitution operation', () => {
  it('create: () ((1 1)) makes a point', () => {
    const db = new Database();
    const report = db.query('() ((1 1))');
    expect(report.operation).toBe('create');
    expect(report.created).toEqual([{ index: 1, source: 1, target: 1 }]);
    expect(db.count()).toBe(1);
  });

  it('read: a lone restriction returns matches without mutating', () => {
    const db = new Database();
    db.query('() ((1 1))');
    const report = db.query('((1: 1 1))');
    expect(report.operation).toBe('read');
    expect(report.matched.length).toBe(1);
    expect(report.matched[0].links[0]).toEqual({
      index: 1,
      source: 1,
      target: 1,
    });
    expect(report.created).toEqual([]);
    expect(report.updated).toEqual([]);
    expect(report.deleted).toEqual([]);
  });

  it('read: variables bind to every link', () => {
    const db = new Database();
    db.query('() ((1 1))');
    db.query('() ((1 2))');
    const report = db.query('(($i: $s $t))');
    expect(report.operation).toBe('read');
    expect(report.matched.length).toBe(2);
    const bindings = report.matched.map((row) => row.binding);
    expect(bindings).toEqual([
      { i: 1, s: 1, t: 1 },
      { i: 2, s: 1, t: 2 },
    ]);
  });

  it('update: ((1: 1 1)) ((1: 1 2)) rewrites in place', () => {
    const db = new Database();
    db.query('() ((1 1))');
    const report = db.query('((1: 1 1)) ((1: 1 2))');
    expect(report.operation).toBe('update');
    expect(report.updated).toEqual([{ index: 1, source: 1, target: 2 }]);
    expect(db.count()).toBe(1);
  });

  it('delete: ((1 2)) () removes the match', () => {
    const db = new Database();
    db.query('() ((1 2))');
    const report = db.query('((1 2)) ()');
    expect(report.operation).toBe('delete');
    expect(report.deleted).toEqual([{ index: 1, source: 1, target: 2 }]);
    expect(db.count()).toBe(0);
  });

  it('a non-matching restriction makes no changes', () => {
    const db = new Database();
    db.query('() ((1 1))');
    const report = db.query('((9: 9 9)) ((9: 9 8))');
    expect(report.operation).toBe('noop');
    expect(db.count()).toBe(1);
  });
});

describe('conjunctive join across patterns', () => {
  it('composes edges by sharing a variable', () => {
    const db = new Database();
    // Edges 1->2 and 2->3 (identities allocated automatically).
    db.query('() ((1 2))');
    db.query('() ((2 3))');
    // Match a 2-hop path: ($x -> $y) and ($y -> $z).
    const report = db.query('(($x $y) ($y $z))');
    expect(report.operation).toBe('read');
    expect(report.matched.length).toBe(1);
    expect(report.matched[0].binding).toEqual({ x: 1, y: 2, z: 3 });
  });
});

describe('named references', () => {
  it('auto-creates names as points and links them', () => {
    const db = new Database();
    const report = db.query('() ((alice bob))');
    expect(report.operation).toBe('create');
    // alice and bob become points; the relation links them.
    expect(db.count()).toBe(3);
    const alice = db.names.resolve('alice');
    const bob = db.names.resolve('bob');
    expect(db.store.findByPair(alice, bob)).not.toBeUndefined();
  });

  it('honours autoCreate=false', () => {
    const names = new Names(new LinksStore(), { autoCreate: false });
    expect(() => names.ensure('ghost')).toThrow(UnknownNameError);
  });
});

describe('splitQuery', () => {
  it('treats one node as a read', () => {
    const split = splitQuery(parse('((1: 1 1))'));
    expect(split.substitution).toBeNull();
  });

  it('treats two nodes as restriction + substitution', () => {
    const split = splitQuery(parse('((1 1)) ((1 2))'));
    expect(split.restriction.length).toBe(1);
    expect(split.substitution.length).toBe(1);
  });

  it('rejects more than two top-level nodes', () => {
    expect(() => splitQuery(parse('(1) (2) (3)'))).toThrow();
  });
});

describe('serialisation and introspection', () => {
  it('serialises links to canonical LiNo', () => {
    expect(linkToLino({ index: 3, source: 1, target: 2 })).toBe('(3: 1 2)');
  });

  it('round-trips the whole database through LiNo', () => {
    const db = new Database();
    db.query('() ((1 1))');
    db.query('() ((1 2))');
    const text = db.toLino();
    const restored = new Database();
    restored.importLino(text);
    expect(restored.toLino()).toBe(text);
  });

  it('introspects link count and names', () => {
    const db = new Database();
    db.query('() ((alice bob))');
    const info = db.introspect();
    expect(info.linkCount).toBe(3);
    expect(info.names.map((n) => n.name)).toContain('alice');
  });
});
