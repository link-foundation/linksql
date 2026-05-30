/**
 * LinksQL — public API.
 *
 * LinksQL is an associative query language built on a single primitive (the
 * link, a doublet) and a single operation (substitution). This module is the
 * package entry point: it re-exports the notation, the engine, the query
 * executor, the subscription/trigger layer and the HTTP server and client.
 *
 * @example
 *   import { Database } from '@link-foundation/linksql';
 *   const db = new Database();
 *   db.query('() ((alice loves bob))'); // create
 *   db.query('((alice $x))');           // read everything alice links to
 */

export {
  parse,
  serialize,
  serializeAll,
  tokenize,
  LinoSyntaxError,
} from './lino.js';

export { LinksStore, LinkIntegrityError } from './store.js';

export { Names, UnknownNameError } from './names.js';

export {
  match,
  execute,
  linkMatches,
  linkSlots,
  SubstitutionError,
} from './substitution.js';

export { Database, QueryError, splitQuery, linkToLino } from './query.js';

export {
  Subscriptions,
  Triggers,
  TriggerError,
  TRIGGER_MODES,
} from './triggers.js';

export { LinksQLServer, startServer } from './server.js';

export { LinksQLClient } from './client.js';

import { Database } from './query.js';

/**
 * Convenience factory for a fresh in-memory database.
 *
 * @param {object} [options] - Forwarded to the {@link Database} constructor.
 * @returns {Database} A new database.
 */
export function createDatabase(options) {
  return new Database(options);
}
