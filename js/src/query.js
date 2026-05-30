/**
 * High-level query executor: the public face of the engine.
 *
 * A `Database` bundles a links store with a name registry and exposes a single
 * `query` method that accepts LiNo text. The text is parsed into a restriction
 * and a substitution, the operation runs, and a structured, JSON-serialisable
 * report comes back describing what matched and what changed.
 */

import { parse, serialize } from './lino.js';
import { LinksStore } from './store.js';
import { Names } from './names.js';
import { execute, match, SubstitutionError } from './substitution.js';

/** Error thrown when query text is well-formed LiNo but not a valid query. */
export class QueryError extends Error {
  /** @param {string} message - Human readable description. */
  constructor(message) {
    super(message);
    this.name = 'QueryError';
  }
}

/**
 * Extract the pattern list from a restriction/substitution wrapper node.
 *
 * @param {object} node - A top-level `link` node.
 * @returns {object[]} The contained pattern nodes.
 */
function patternsOf(node) {
  if (node.type !== 'link' || node.id !== null) {
    throw new QueryError(
      'A restriction or substitution must be a parenthesised list of patterns'
    );
  }
  return node.values;
}

/**
 * Split parsed LiNo nodes into a restriction and an (optional) substitution.
 *
 * One top-level value is a read (restriction only). Two values are the canonical
 * `(restriction) (substitution)` form. Anything else is ambiguous.
 *
 * @param {object[]} nodes - Parsed top-level nodes.
 * @returns {{restriction: object[], substitution: object[]|null}} Split query.
 */
export function splitQuery(nodes) {
  if (nodes.length === 0) {
    return { restriction: [], substitution: null };
  }
  if (nodes.length === 1) {
    return { restriction: patternsOf(nodes[0]), substitution: null };
  }
  if (nodes.length === 2) {
    return {
      restriction: patternsOf(nodes[0]),
      substitution: patternsOf(nodes[1]),
    };
  }
  throw new QueryError(
    'A query must be "(restriction)" or "(restriction) (substitution)"'
  );
}

/**
 * Convert a stored link to its canonical LiNo node.
 *
 * @param {{index: number, source: number, target: number}} link - A link.
 * @returns {object} A `link` AST node.
 */
function linkToNode(link) {
  return {
    type: 'link',
    id: { type: 'ref', kind: 'number', value: link.index },
    values: [
      { type: 'ref', kind: 'number', value: link.source },
      { type: 'ref', kind: 'number', value: link.target },
    ],
  };
}

/**
 * Serialise a link to canonical LiNo text, e.g. `(3: 1 2)`.
 *
 * @param {{index: number, source: number, target: number}} link - A link.
 * @returns {string} LiNo text.
 */
export function linkToLino(link) {
  return serialize(linkToNode(link));
}

/** Classify a change report into a human-friendly operation name. */
function classify({ created, updated, deleted }, readOnly) {
  if (readOnly) {
    return 'read';
  }
  const kinds = [
    created.length && 'create',
    updated.length && 'update',
    deleted.length && 'delete',
  ].filter(Boolean);
  if (kinds.length === 0) {
    return 'noop';
  }
  return kinds.length === 1 ? kinds[0] : 'mixed';
}

/** An associative database queried with the single substitution operation. */
export class Database {
  /**
   * @param {object} [options] - Behaviour flags.
   * @param {boolean} [options.autoCreate] - Auto-create missing named refs.
   */
  constructor({ autoCreate = true } = {}) {
    this.store = new LinksStore();
    this.names = new Names(this.store, { autoCreate });
    /** @type {Array<(change: object) => void>} */
    this.listeners = [];
  }

  /** @returns {object} The execution context passed to the engine. */
  get context() {
    return { store: this.store, names: this.names };
  }

  /**
   * Register a change listener (used by the subscription layer).
   *
   * @param {(change: object) => void} listener - Callback for each change.
   * @returns {() => void} An unsubscribe function.
   */
  onChange(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Notify listeners about the changes produced by an operation.
   *
   * @param {object} report - The structured query report.
   */
  emit(report) {
    if (
      report.created.length ||
      report.updated.length ||
      report.deleted.length
    ) {
      for (const listener of this.listeners) {
        listener(report);
      }
    }
  }

  /**
   * Run a LinksQL query expressed as LiNo text.
   *
   * @param {string} text - The query, e.g. `() ((1 1))`.
   * @returns {object} A structured, JSON-serialisable report.
   */
  query(text) {
    let nodes;
    try {
      nodes = parse(text);
    } catch (error) {
      throw new QueryError(`Invalid LiNo: ${error.message}`);
    }
    const { restriction, substitution } = splitQuery(nodes);
    const readOnly = substitution === null;
    let raw;
    try {
      raw = readOnly
        ? {
            matches: match(restriction, this.context),
            created: [],
            updated: [],
            deleted: [],
          }
        : execute(restriction, substitution, this.context);
    } catch (error) {
      if (error instanceof SubstitutionError) {
        throw new QueryError(error.message);
      }
      throw error;
    }
    const report = {
      operation: classify(raw, readOnly),
      matched: raw.matches.map((row) => ({
        links: row.links.map((link) => ({ ...link })),
        binding: { ...row.binding },
      })),
      created: raw.created.map((link) => ({ ...link })),
      updated: raw.updated.map((link) => ({ ...link })),
      deleted: raw.deleted.map((link) => ({ ...link })),
    };
    this.emit(report);
    return report;
  }

  /** @returns {Array<{index: number, source: number, target: number}>} All links. */
  links() {
    return this.store.all();
  }

  /** @returns {number} Number of links currently stored. */
  count() {
    return this.store.size;
  }

  /**
   * Serialise the whole database to canonical LiNo, one link per line.
   *
   * @returns {string} LiNo text.
   */
  toLino() {
    return this.store.all().map(linkToLino).join('\n');
  }

  /**
   * Bulk-import links from LiNo text (each top-level link is created).
   *
   * @param {string} text - LiNo text of `(index: source target)` links.
   * @returns {number} The number of links imported.
   */
  importLino(text) {
    const nodes = parse(text);
    let count = 0;
    for (const node of nodes) {
      const report = this.query(`() (${serialize(node)})`);
      count += report.created.length;
    }
    return count;
  }

  /**
   * Describe the database for introspection tooling.
   *
   * @returns {object} Link count, named references and the links themselves.
   */
  introspect() {
    return {
      linkCount: this.store.size,
      names: this.names.entries().map(([name, index]) => ({ name, index })),
      links: this.store.all(),
    };
  }

  /** Remove every link and name. */
  clear() {
    this.store.clear();
    this.names.byName.clear();
    this.names.byIndex.clear();
  }
}
