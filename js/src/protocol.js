/**
 * LinksQL wire protocol — Links Notation as the data transfer format.
 *
 * The issue (and the PR review) is explicit: Links Notation, not JSON, is the
 * actual data protocol. Every structured value that crosses the network — query
 * reports, link lists, introspection snapshots, subscription events — travels as
 * Links Notation text. Inside a JavaScript process we still work with plain
 * objects (JSON-shaped), so this module is the single boundary that converts
 * between the two using `lino-objects-codec`:
 *
 *   object  --encode-->  "((operation update) (created ()) ...)"
 *   "(...)"  --decode-->  object
 *
 * Keeping the conversion in one place means the server, the client and the CLI
 * all speak the same Links Notation dialect, and JSON only ever appears as an
 * opt-in convenience (e.g. for a browser that asks for `application/json`).
 */

import { jsonToLino, linoToJson } from 'lino-objects-codec';

/** The canonical content type for Links Notation payloads. */
export const LINO_CONTENT_TYPE = 'application/lino';

/** The opt-in content type for the JSON projection of a payload. */
export const JSON_CONTENT_TYPE = 'application/json';

/**
 * Encode a plain JavaScript value as Links Notation text.
 *
 * @param {unknown} value - Any JSON-shaped value (object, array, scalar).
 * @returns {string} The value rendered as Links Notation.
 */
export function encode(value) {
  return jsonToLino({ json: value });
}

/**
 * Decode Links Notation text back into a plain JavaScript value.
 *
 * @param {string} lino - Links Notation text produced by {@link encode}.
 * @returns {unknown} The reconstructed value.
 */
export function decode(lino) {
  return linoToJson({ lino });
}

/**
 * Decide whether a caller prefers the JSON projection over Links Notation.
 *
 * Links Notation is always the default; JSON is only used when a client opts in
 * through a standard `Accept` (or `Content-Type`) header. This keeps the wire
 * protocol Links-Notation-first while remaining friendly to plain browsers.
 *
 * @param {string|undefined} header - An `Accept` or `Content-Type` header value.
 * @returns {boolean} True when JSON should be used instead of Links Notation.
 */
export function prefersJson(header) {
  if (!header) {
    return false;
  }
  const lower = header.toLowerCase();
  if (lower.includes(LINO_CONTENT_TYPE)) {
    return false;
  }
  return lower.includes('application/json') || lower.includes('text/json');
}
