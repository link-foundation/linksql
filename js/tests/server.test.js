/**
 * Tests for the HTTP server and its matching client, including the Server-Sent
 * Events subscription stream.
 *
 * The server binds a TCP port and the client uses `fetch`, so the whole suite
 * needs network access. Deno CI runs `deno test --allow-read` only, so these
 * end-to-end tests run on Node and Bun; on Deno the suite is skipped.
 */

import { describe, it, expect } from 'test-anywhere';
import { LinksQLServer } from '../src/server.js';
import { LinksQLClient } from '../src/client.js';
import { decode } from '../src/protocol.js';

const isDenoRuntime = typeof Deno !== 'undefined';

/** Start a server on an ephemeral port, run `body`, then always close it. */
async function withServer(body) {
  const server = new LinksQLServer({ name: 'linksql', version: '1.2.3' });
  await server.listen(0);
  const client = new LinksQLClient(server.url);
  try {
    await body(server, client);
  } finally {
    await server.close();
  }
}

describe('LinksQLServer + LinksQLClient', () => {
  if (isDenoRuntime) {
    it('runs over HTTP on runtimes with network access (Node, Bun)', () => {
      // Deno CI grants `--allow-read` only; the networked suite runs elsewhere.
      expect(isDenoRuntime).toBe(true);
    });
    return;
  }

  it('runs a query over HTTP', async () => {
    await withServer(async (server, client) => {
      const report = await client.query('() ((1 1))');
      expect(report.operation).toBe('create');
      expect(report.created.length).toBe(1);
      expect(server.db.count()).toBe(1);
    });
  });

  it('lists links and introspects', async () => {
    await withServer(async (server, client) => {
      await client.query('() ((1 2))');
      const links = await client.links();
      expect(links.length).toBe(1);
      const info = await client.introspect();
      expect(info.linkCount).toBe(1);
    });
  });

  it('imports and exports LiNo', async () => {
    await withServer(async (server, client) => {
      const imported = await client.importLino('(1: 1 1)\n(2: 1 2)');
      expect(imported).toBe(2);
      const text = await client.export();
      expect(text).toBe('(1: 1 1)\n(2: 1 2)');
    });
  });

  it('reports the server status as Links Notation by default', async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/`);
      expect(response.headers.get('content-type')).toContain(
        'application/lino'
      );
      const status = decode(await response.text());
      expect(status.name).toBe('linksql');
      expect(status.version).toBe('1.2.3');
      expect(status.links).toBe(0);
    });
  });

  it('reports the server status as JSON when the client asks for it', async () => {
    await withServer(async (server) => {
      const response = await fetch(`${server.url}/`, {
        headers: { accept: 'application/json' },
      });
      expect(response.headers.get('content-type')).toContain(
        'application/json'
      );
      const status = await response.json();
      expect(status.name).toBe('linksql');
      expect(status.version).toBe('1.2.3');
      expect(status.links).toBe(0);
    });
  });

  it('rejects an invalid query with an error', async () => {
    await withServer(async (server, client) => {
      let threw = false;
      try {
        await client.query('(1) (2) (3)');
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });

  it('streams matching changes over SSE', async () => {
    await withServer(async (server, client) => {
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
      const sub = client.subscribe('((1 $x))', (event) => {
        events.push(event);
        resolveGot();
      });
      await sub.ready;
      await client.query('() ((1 2))');
      await got;
      sub.close();
      await sub.done;

      expect(events.length).toBe(1);
      expect(events[0].operation).toBe('create');
      expect(events[0].matching.length).toBe(1);
    });
  });
});
