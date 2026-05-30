/**
 * Schema-driven server example for LinksQL.
 *
 * Demonstrates the GraphQL-class schema layer: a schema written in Links
 * Notation declares types, relations, a named query and a named subscription;
 * `createSchemaServer` turns that schema into a running HTTP API; and the client
 * introspects the schema, runs the named query and consumes the subscription —
 * the LinksQL answer to GraphQL's schema, `__schema`, operations and live feeds.
 *
 * Run with any runtime that has network access:
 * - Node.js: node examples/schema-server.js
 * - Bun:     bun examples/schema-server.js
 */

import { createSchemaServer, LinksQLClient } from '../src/index.js';

const schema = `(schema social
  (type Person)
  (type Post)
  (relation name (from Person) (to Text))
  (relation author (from Post) (to Person))
  (relation likes (from Person) (to Post))
  (query everyone (($p: $p $p)))
  (subscription newPoints (($p: $p $p))))`;

// Generate and start a server straight from the schema.
const server = await createSchemaServer(schema, { version: '1.0.0' });
const client = new LinksQLClient(server.url);

try {
  // Introspect the schema — the GraphQL `__schema` analogue.
  console.log('Schema introspection:');
  const doc = await client.schema();
  console.log(`  name: ${doc.name}`);
  console.log(`  types: ${doc.types.join(', ')}`);
  console.log(`  scalars: ${doc.scalars.join(', ')}`);
  for (const relation of doc.relations) {
    console.log(
      `  relation ${relation.name}: ${relation.from} -> ${relation.to}`
    );
  }
  console.log(`  queries: ${doc.queries.map((q) => q.name).join(', ')}`);
  console.log(
    `  subscriptions: ${doc.subscriptions.map((s) => s.name).join(', ')}`
  );

  // Subscribe to the named live feed before mutating.
  console.log('\nSubscribing to "newPoints"...');
  const events = [];
  const sub = client.subscribeNamed('newPoints', (event) => {
    events.push(event);
  });
  await sub.ready;

  // Seed a couple of points so the named `everyone` read has matches.
  await client.query('() ((1 1))');
  await client.query('() ((2 2))');

  // Run the named query declared in the schema.
  console.log('\nRunning named query "everyone":');
  const report = await client.runNamed('everyone');
  console.log(`  operation = ${report.operation}`);
  console.log(`  matched ${report.matched.length} link(s)`);

  // Give the SSE stream a moment to deliver, then report what arrived.
  await new Promise((resolve) => setTimeout(resolve, 50));
  console.log(`\nSubscription delivered ${events.length} event(s).`);
  sub.close();
  await sub.done;
} finally {
  await server.close();
}
