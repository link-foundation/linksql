/**
 * Subscriptions and persistent transformation triggers.
 *
 * GraphQL has subscriptions; link-cli has the `--once`/`--always`/`--never`
 * flags that control how many times a substitution is applied. LinksQL unifies
 * both ideas on top of {@link Database.onChange}:
 *
 *   - {@link Subscriptions} is the pub/sub primitive — a client subscribes to a
 *     restriction pattern and is notified whenever a change touches a matching
 *     link. This is what the HTTP server streams over Server-Sent Events and the
 *     direct replacement for a GraphQL subscription.
 *
 *   - {@link Triggers} installs server-side reactive rules. A rule is an ordinary
 *     `(restriction) (substitution)` query plus a mode:
 *       never   read-only; report matches, never mutate (link-cli `--never`)
 *       once    apply the substitution exactly once (link-cli `--once`)
 *       always  apply repeatedly to a fixpoint and re-apply on every change,
 *               turning the query into a standing transformation rule
 *               (link-cli `--always`)
 */

import { parse, serializeAll } from './lino.js';
import { splitQuery } from './query.js';
import { linkMatches } from './substitution.js';

/** The trigger modes, mirroring link-cli's persistence flags. */
export const TRIGGER_MODES = Object.freeze(['never', 'once', 'always']);

/** Error thrown when a trigger is misconfigured or fails to stabilise. */
export class TriggerError extends Error {
  /** @param {string} message - Human readable description. */
  constructor(message) {
    super(message);
    this.name = 'TriggerError';
  }
}

/** @returns {boolean} Whether a change report mutated anything. */
function mutated(report) {
  return (
    report.created.length > 0 ||
    report.updated.length > 0 ||
    report.deleted.length > 0
  );
}

/**
 * Pattern-filtered pub/sub over a database's change stream.
 *
 * Each subscriber registers a restriction pattern; when an operation creates,
 * updates or deletes a link that matches the pattern, the subscriber's callback
 * receives the operation name together with the matching links.
 */
export class Subscriptions {
  /** @param {import('./query.js').Database} db - The database to observe. */
  constructor(db) {
    this.db = db;
    /** @type {Array<{restriction: object[], callback: Function}>} */
    this.subs = [];
    this.unsubscribe = db.onChange((change) => this.dispatch(change));
  }

  /**
   * Subscribe to changes that touch links matching a pattern.
   *
   * @param {string} patternText - A restriction, e.g. `((alice $x))`. An empty
   *   restriction (`()`) matches every change.
   * @param {(event: {operation: string, matching: object[]}) => void} callback -
   *   Invoked once per operation that touches at least one matching link.
   * @returns {() => void} An unsubscribe function.
   */
  subscribe(patternText, callback) {
    const { restriction } = splitQuery(parse(patternText));
    const sub = { restriction, callback };
    this.subs.push(sub);
    return () => {
      this.subs = this.subs.filter((entry) => entry !== sub);
    };
  }

  /**
   * Fan a change report out to every matching subscriber.
   *
   * @param {object} change - A report emitted by {@link Database.emit}.
   */
  dispatch(change) {
    const touched = [...change.created, ...change.updated, ...change.deleted];
    for (const sub of this.subs) {
      const matching = touched.filter((link) =>
        linkMatches(sub.restriction, link, this.db.context)
      );
      if (matching.length > 0) {
        sub.callback({ operation: change.operation, matching });
      }
    }
  }

  /** @returns {number} Number of active subscribers. */
  get size() {
    return this.subs.length;
  }

  /** Detach from the database and drop every subscriber. */
  dispose() {
    this.unsubscribe();
    this.subs = [];
  }
}

/**
 * Installed transformation rules that react to database changes.
 *
 * The class drives `always` rules to a fixpoint and re-applies them whenever the
 * database changes, while guarding against the re-entrancy its own mutations
 * would otherwise cause.
 */
export class Triggers {
  /**
   * @param {import('./query.js').Database} db - The database to govern.
   * @param {object} [options] - Behaviour flags.
   * @param {number} [options.maxIterations] - Fixpoint iteration ceiling.
   */
  constructor(db, { maxIterations = 1000 } = {}) {
    this.db = db;
    this.maxIterations = maxIterations;
    /** @type {Array<object>} */
    this.rules = [];
    /** Guards against reacting to our own mutations. */
    this.firing = false;
    this.unsubscribe = db.onChange(() => this.react());
  }

  /**
   * Install a trigger.
   *
   * @param {string} queryText - A LinksQL query, e.g. `((1 1)) ((1 2))`.
   * @param {object} [options] - Trigger configuration.
   * @param {'never'|'once'|'always'} [options.mode] - Persistence mode.
   * @param {(report: object, rule: object) => void} [options.onFire] - Notified
   *   after each application with the resulting report.
   * @returns {object} The installed rule (a stable handle for {@link remove}).
   */
  add(queryText, { mode = 'always', onFire = null } = {}) {
    if (!TRIGGER_MODES.includes(mode)) {
      throw new TriggerError(
        `Unknown trigger mode "${mode}" (expected never|once|always)`
      );
    }
    const nodes = parse(queryText);
    const readText = nodes.length > 0 ? serializeAll(nodes.slice(0, 1)) : '()';
    const rule = {
      queryText,
      readText,
      mode,
      onFire,
      active: mode === 'always',
      fired: 0,
      lastReport: null,
    };
    this.rules.push(rule);
    this.fireInitial(rule);
    return rule;
  }

  /**
   * Apply a freshly-added rule for the first time according to its mode.
   *
   * @param {object} rule - The rule to prime.
   */
  fireInitial(rule) {
    if (rule.mode === 'once') {
      this.guarded(() => this.fireRule(rule));
    } else if (rule.mode === 'always') {
      this.runToFixpoint();
    } else {
      this.fireRule(rule); // never: read-only report of current matches
    }
  }

  /**
   * Run one rule, reading for `never` rules and transforming otherwise.
   *
   * @param {object} rule - The rule to fire.
   * @returns {object} The query report.
   */
  fireRule(rule) {
    const text = rule.mode === 'never' ? rule.readText : rule.queryText;
    const report = this.db.query(text);
    rule.fired += 1;
    rule.lastReport = report;
    if (rule.onFire) {
      rule.onFire(report, rule);
    }
    return report;
  }

  /** React to an external change by re-applying active rules and re-reading watches. */
  react() {
    if (this.firing) {
      return; // ignore changes we caused ourselves
    }
    this.runToFixpoint();
    for (const rule of this.rules) {
      if (rule.mode === 'never') {
        this.fireRule(rule);
      }
    }
  }

  /** Apply every active rule repeatedly until nothing changes. */
  runToFixpoint() {
    this.guarded(() => {
      let changed = true;
      let iterations = 0;
      while (changed) {
        if (iterations >= this.maxIterations) {
          throw new TriggerError(
            `Triggers did not stabilise after ${this.maxIterations} iterations`
          );
        }
        iterations += 1;
        changed = false;
        for (const rule of this.rules) {
          if (rule.active && mutated(this.fireRule(rule))) {
            changed = true;
          }
        }
      }
    });
  }

  /**
   * Run `body` with the re-entrancy guard raised so our own mutations do not
   * recursively re-trigger the rule set.
   *
   * @param {() => void} body - The work to perform.
   */
  guarded(body) {
    if (this.firing) {
      body();
      return;
    }
    this.firing = true;
    try {
      body();
    } finally {
      this.firing = false;
    }
  }

  /**
   * Remove an installed rule.
   *
   * @param {object} rule - The handle returned by {@link add}.
   * @returns {boolean} Whether a rule was removed.
   */
  remove(rule) {
    const before = this.rules.length;
    this.rules = this.rules.filter((entry) => entry !== rule);
    return this.rules.length < before;
  }

  /** @returns {number} Number of installed rules. */
  get size() {
    return this.rules.length;
  }

  /** Detach from the database and drop every rule. */
  dispose() {
    this.unsubscribe();
    this.rules = [];
  }
}
