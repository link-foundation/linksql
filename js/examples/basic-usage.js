/**
 * Basic usage example for LinksQL.
 *
 * Demonstrates the single substitution operation — `(restriction) (substitution)`
 * — driving create, read, update and delete against an in-memory database.
 *
 * Every link is a doublet: `(index: source target)`. A relation like
 * "alice loves bob" is therefore a *higher-order* link — its source is the link
 * `(alice loves)` and its target is `bob`, written `((alice loves) bob)`.
 *
 * Run with any runtime:
 * - Node.js: node examples/basic-usage.js
 * - Bun:     bun examples/basic-usage.js
 * - Deno:    deno run --allow-read examples/basic-usage.js
 */

import { createDatabase, encode } from '../src/index.js';

const db = createDatabase();

// CREATE: an empty restriction with one substitution creates a link.
// Named references (alice, loves, bob) are auto-created as points first, then
// the nested link `(alice loves)` and finally the relation to `bob`.
console.log('Create:');
const created = db.query('() (((alice loves) bob))');
console.log(`  operation = ${created.operation}`);
console.log(`  store now holds ${db.count()} links`);
console.log(`  ${db.toLino().split('\n').join('\n  ')}`);

// READ: a lone restriction with variables matches without mutating.
console.log('\nRead every link (($i: $s $t)):');
const read = db.query('(($i: $s $t))');
for (const row of read.matched) {
  // Links Notation is the data protocol: bindings travel as LiNo, not JSON.
  console.log(`  binding ${encode(row.binding)}`);
}

// UPDATE: pairing a match with a new shape rewrites it in place, keeping its id.
console.log('\nUpdate (alice loves) -> (alice trusts):');
const updated = db.query('((alice loves)) ((alice trusts))');
console.log(`  operation = ${updated.operation}`);
console.log(`  updated = ${encode(updated.updated)}`);

// DELETE: a trailing restriction with no substitution removes the match.
console.log('\nDelete (alice trusts):');
const deleted = db.query('((alice trusts)) ()');
console.log(`  operation = ${deleted.operation}`);
console.log(`  store now holds ${db.count()} links`);

// INTROSPECT: names and link count, the LinksQL answer to a GraphQL schema.
console.log('\nIntrospection:');
const info = db.introspect();
console.log(`  ${info.linkCount} links`);
console.log(`  names: ${info.names.map((entry) => entry.name).join(', ')}`);
