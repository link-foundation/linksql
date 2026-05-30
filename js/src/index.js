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
 *   db.query('() (((alice loves) bob))'); // create the higher-order link
 *   db.query('(((alice loves) $x))');     // read everything `alice loves` points to
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

export { LinksQLServer, startServer, createSchemaServer } from './server.js';

export { LinksQLClient } from './client.js';

export { Schema, SchemaError } from './schema.js';

export {
  encode,
  decode,
  prefersJson,
  LINO_CONTENT_TYPE,
  JSON_CONTENT_TYPE,
} from './protocol.js';

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
