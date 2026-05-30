/**
 * Tests for the package entry point: the public API surface re-exported from
 * `src/index.js`. These run on Node.js, Bun, and Deno (read-only).
 */

import { describe, it, expect } from 'test-anywhere';
import {
  createDatabase,
  Database,
  parse,
  serializeAll,
  match,
  execute,
  linkMatches,
  splitQuery,
  linkToLino,
  Subscriptions,
  Triggers,
  TRIGGER_MODES,
  LinksQLServer,
  LinksQLClient,
} from '../src/index.js';

describe('public API surface', () => {
  it('re-exports the notation, engine, query, trigger, and net layers', () => {
    expect(typeof parse).toBe('function');
    expect(typeof serializeAll).toBe('function');
    expect(typeof match).toBe('function');
    expect(typeof execute).toBe('function');
    expect(typeof linkMatches).toBe('function');
    expect(typeof splitQuery).toBe('function');
    expect(typeof linkToLino).toBe('function');
    expect(typeof Database).toBe('function');
    expect(typeof Subscriptions).toBe('function');
    expect(typeof Triggers).toBe('function');
    expect(typeof LinksQLServer).toBe('function');
    expect(typeof LinksQLClient).toBe('function');
    expect(TRIGGER_MODES).toEqual(['never', 'once', 'always']);
  });
});

describe('createDatabase factory', () => {
  it('returns a fresh, empty Database', () => {
    const db = createDatabase();
    expect(db instanceof Database).toBe(true);
    expect(db.count()).toBe(0);
  });

  it('runs the canonical create / read / update / delete cycle', () => {
    const db = createDatabase();

    const created = db.query('() ((1 1))');
    expect(created.operation).toBe('create');
    expect(created.created).toEqual([{ index: 1, source: 1, target: 1 }]);

    const read = db.query('((1: 1 1))');
    expect(read.operation).toBe('read');
    expect(read.matched.length).toBe(1);

    const updated = db.query('((1: 1 1)) ((1: 1 2))');
    expect(updated.operation).toBe('update');
    expect(updated.updated).toEqual([{ index: 1, source: 1, target: 2 }]);

    const deleted = db.query('((1: 1 2)) ()');
    expect(deleted.operation).toBe('delete');
    expect(db.count()).toBe(0);
  });

  it('forwards options to the Database constructor', () => {
    const db = createDatabase({ autoCreate: false });
    expect(() => db.query('() ((ghost ghost))')).toThrow();
  });
});
