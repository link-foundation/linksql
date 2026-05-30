/**
 * Tests for the GraphQL-class schema layer: parsing a schema written in Links
 * Notation, introspecting it, rendering it back to LiNo, and the server that is
 * generated from it (named queries, named subscriptions and the `/schema`
 * introspection endpoint).
 *
 * The networked, server-generation tests bind a TCP port and use `fetch`, so —
 * like the server suite — they run on Node and Bun and are skipped on Deno,
 * whose CI grants `--allow-read` only.
 */

import { describe, it, expect } from 'test-anywhere';
import { Schema, SchemaError } from '../src/schema.js';
import { createSchemaServer } from '../src/server.js';
import { LinksQLClient } from '../src/client.js';

const SCHEMA_TEXT = `(schema social
  (type Person)
  (type Post)
  (relation name (from Person) (to Text))
  (relation author (from Post) (to Person))
  (relation likes (from Person) (to Post))
  (query everyone (($p: $p $p)))
  (subscription newLikes ((1 $post))))`;

const isDenoRuntime = typeof Deno !== 'undefined';

describe('Schema', () => {
  it('parses types, relations, queries and subscriptions', () => {
    const schema = Schema.parse(SCHEMA_TEXT);
    expect(schema.name).toBe('social');
    expect(schema.types).toEqual(['Person', 'Post']);
    expect(schema.relations.length).toBe(3);
    const author = schema.relation('author');
    expect(author.from).toBe('Post');
    expect(author.to).toBe('Person');
    expect(schema.query('everyone').text).toBe('(($p: $p $p))');
    expect(schema.subscription('newLikes').pattern).toBe('((1 $post))');
  });

  it('infers scalar types from relation endpoints', () => {
    const schema = Schema.parse(SCHEMA_TEXT);
    // `Text` is referenced but never declared as a type, so it is a scalar.
    expect(schema.scalars).toEqual(['Text']);
    expect(schema.knows('Person')).toBe(true);
    expect(schema.knows('Text')).toBe(true);
    expect(schema.knows('likes')).toBe(true);
    expect(schema.knows('missing')).toBe(false);
  });

  it('produces an introspection document', () => {
    const doc = Schema.parse(SCHEMA_TEXT).introspect();
    expect(doc.name).toBe('social');
    expect(doc.types).toEqual(['Person', 'Post']);
    expect(doc.relations.map((relation) => relation.name)).toEqual([
      'name',
      'author',
      'likes',
    ]);
    expect(doc.queries.map((query) => query.name)).toEqual(['everyone']);
    expect(doc.subscriptions.map((sub) => sub.name)).toEqual(['newLikes']);
  });

  it('round-trips through Links Notation', () => {
    const schema = Schema.parse(SCHEMA_TEXT);
    const reparsed = Schema.parse(schema.toLino());
    expect(reparsed.introspect()).toEqual(schema.introspect());
  });

  it('validates relations', () => {
    const schema = Schema.parse(SCHEMA_TEXT);
    expect(schema.validateRelation('likes').name).toBe('likes');
    expect(() => schema.validateRelation('missing')).toThrow(SchemaError);
  });

  it('rejects malformed schemas', () => {
    expect(() => Schema.parse('(person)')).toThrow(SchemaError);
    expect(() => Schema.parse('(schema (relation r (from A)))')).toThrow(
      SchemaError
    );
    expect(() => Schema.parse('(schema (mutate x))')).toThrow(SchemaError);
  });
});

describe('Schema-generated server', () => {
  if (isDenoRuntime) {
    it('runs over HTTP on runtimes with network access (Node, Bun)', () => {
      expect(isDenoRuntime).toBe(true);
    });
    return;
  }

  /** Start a schema-generated server, run `body`, then always close it. */
  async function withSchemaServer(body) {
    const server = await createSchemaServer(SCHEMA_TEXT, { version: '2.0.0' });
    const client = new LinksQLClient(server.url);
    try {
      await body(server, client);
    } finally {
      await server.close();
    }
  }

  it('takes its name from the schema', async () => {
    await withSchemaServer((server) => {
      expect(server.name).toBe('social');
      expect(server.schema.name).toBe('social');
    });
  });

  it('serves the schema introspection document', async () => {
    await withSchemaServer(async (server, client) => {
      const doc = await client.schema();
      expect(doc.name).toBe('social');
      expect(doc.types).toEqual(['Person', 'Post']);
      expect(doc.relations.length).toBe(3);
    });
  });

  it('runs a named query', async () => {
    await withSchemaServer(async (server, client) => {
      // Seed a point so the `everyone` read (($p: $p $p)) has something to match.
      await client.query('() ((1 1))');
      const report = await client.runNamed('everyone');
      expect(report.operation).toBe('read');
      expect(report.matched.length).toBe(1);
    });
  });

  it('rejects an unknown named query', async () => {
    await withSchemaServer(async (server, client) => {
      let threw = false;
      try {
        await client.runNamed('missing');
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });

  it('streams a named subscription', async () => {
    await withSchemaServer(async (server, client) => {
      const events = [];
      let resolveGot;
      const got = new Promise((resolve, reject) => {
        resolveGot = resolve;
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for SSE event')),
          5000
        );
        if (timer.unref) {
          timer.unref();
        }
      });
      const sub = client.subscribeNamed('newLikes', (event) => {
        events.push(event);
        resolveGot();
      });
      await sub.ready;
      // newLikes watches `((1 $post))`; create such a link to trigger it.
      await client.query('() ((1 2))');
      await got;
      sub.close();
      await sub.done;

      expect(events.length).toBe(1);
      expect(events[0].operation).toBe('create');
    });
  });
});
