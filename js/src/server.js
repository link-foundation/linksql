/**
 * LinksQL HTTP server.
 *
 * The issue asks for "both server and client". This module exposes a `Database`
 * over plain HTTP using only Node's built-in `http` module — no framework, no
 * dependencies — so the reference server stays as portable as the language
 * implementations it sits alongside.
 *
 * Links Notation is the wire protocol. Every structured response is encoded as
 * Links Notation text (content type `application/lino`); a client may opt into
 * a JSON projection with `Accept: application/json`. Request bodies are read as
 * Links Notation by default too.
 *
 * Endpoints
 *   GET  /                status: name, version and link count
 *   POST /query           run a query (raw LiNo, or `((query "..."))`)
 *   GET  /links           every stored link
 *   GET  /introspect      schema/introspection snapshot
 *   POST /import          bulk-import LiNo text, returns `((imported N))`
 *   GET  /export          the whole database as canonical LiNo text
 *   GET  /subscribe?pattern=...   Server-Sent Events stream of matching changes
 *
 * A subscription is the direct replacement for a GraphQL subscription: the
 * client supplies a restriction pattern and receives an SSE message whenever an
 * operation touches a matching link.
 */

import http from 'node:http';
import { Database } from './query.js';
import { Subscriptions } from './triggers.js';
import {
  encode,
  decode,
  LINO_CONTENT_TYPE,
  JSON_CONTENT_TYPE,
  prefersJson,
} from './protocol.js';

/** SSE keep-alive comment, sent once to flush headers and open the stream. */
const SSE_OPEN = ': linksql stream open\n\n';

/** Read a request body to a string. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Send a structured value, negotiating Links Notation (default) or JSON.
 *
 * @param {http.IncomingMessage} req - The request (its `Accept` header decides).
 * @param {http.ServerResponse} res - The response.
 * @param {number} status - HTTP status code.
 * @param {unknown} value - The value to encode.
 */
function sendData(req, res, status, value) {
  const asJson = prefersJson(req.headers.accept);
  const payload = asJson ? JSON.stringify(value) : encode(value);
  const type = asJson ? JSON_CONTENT_TYPE : LINO_CONTENT_TYPE;
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Send a plain-text response. */
function sendText(res, status, text) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * Extract the query text from a request body honouring its content type.
 *
 * A JSON body may wrap the query as `{ "query": "..." }`; a Links Notation body
 * may wrap it as `((query "..."))`. Any other body is treated as raw query text
 * (the LinksQL query language is itself Links Notation).
 *
 * @param {string} body - The raw request body.
 * @param {string|undefined} contentType - The request `Content-Type` header.
 * @returns {string} The query text to execute.
 */
function queryFromBody(body, contentType) {
  if (contentType && contentType.includes('application/json')) {
    const parsed = JSON.parse(body);
    if (typeof parsed.query !== 'string') {
      throw new Error('JSON body must contain a string "query" field');
    }
    return parsed.query;
  }
  if (contentType && contentType.includes(LINO_CONTENT_TYPE)) {
    const parsed = decode(body);
    if (parsed && typeof parsed === 'object' && 'query' in parsed) {
      const { query } = /** @type {{query: unknown}} */ (parsed);
      if (typeof query !== 'string') {
        throw new Error('Links Notation body must wrap a string "query"');
      }
      return query;
    }
    throw new Error('Links Notation query body must be `((query "..."))`');
  }
  return body;
}

/** An HTTP front end for a {@link Database}. */
export class LinksQLServer {
  /**
   * @param {object} [options] - Server options.
   * @param {Database} [options.database] - An existing database to serve.
   * @param {boolean} [options.autoCreate] - Passed through when creating one.
   * @param {string} [options.name] - Reported in the status payload.
   * @param {string} [options.version] - Reported in the status payload.
   */
  constructor({
    database,
    autoCreate = true,
    name = 'linksql',
    version = '0.0.0',
  } = {}) {
    this.db = database || new Database({ autoCreate });
    this.name = name;
    this.version = version;
    this.subscriptions = new Subscriptions(this.db);
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  /**
   * Route and handle a single request.
   *
   * @param {http.IncomingMessage} req - The request.
   * @param {http.ServerResponse} res - The response.
   */
  async handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /') {
        return this.handleStatus(req, res);
      }
      if (route === 'POST /query') {
        return await this.handleQuery(req, res);
      }
      if (route === 'GET /links') {
        return sendData(req, res, 200, { links: this.db.links() });
      }
      if (route === 'GET /introspect') {
        return sendData(req, res, 200, this.db.introspect());
      }
      if (route === 'POST /import') {
        return await this.handleImport(req, res);
      }
      if (route === 'GET /export') {
        return sendText(res, 200, this.db.toLino());
      }
      if (route === 'GET /subscribe') {
        return this.handleSubscribe(req, res, url);
      }
      return sendData(req, res, 404, { error: `No route for ${route}` });
    } catch (error) {
      return sendData(req, res, 400, { error: error.message });
    }
  }

  /** Respond with the server status. */
  handleStatus(req, res) {
    sendData(req, res, 200, {
      name: this.name,
      version: this.version,
      links: this.db.count(),
    });
  }

  /** Run a query and return its report. */
  async handleQuery(req, res) {
    const body = await readBody(req);
    const text = queryFromBody(body, req.headers['content-type']);
    const report = this.db.query(text);
    sendData(req, res, 200, report);
  }

  /** Bulk-import LiNo text. */
  async handleImport(req, res) {
    const body = await readBody(req);
    const imported = this.db.importLino(body);
    sendData(req, res, 200, { imported });
  }

  /**
   * Open a Server-Sent Events stream for a subscription pattern.
   *
   * @param {http.IncomingMessage} req - The request.
   * @param {http.ServerResponse} res - The response.
   * @param {URL} url - The parsed request URL (for the `pattern` query param).
   */
  handleSubscribe(req, res, url) {
    const pattern = url.searchParams.get('pattern') || '()';
    const asJson = prefersJson(req.headers.accept);
    const unsubscribe = this.subscriptions.subscribe(pattern, (event) => {
      const data = asJson ? JSON.stringify(event) : encode(event);
      res.write(`data: ${data}\n\n`);
    });
    req.on('close', unsubscribe);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(SSE_OPEN);
  }

  /**
   * Start listening.
   *
   * @param {number} [port] - Port (0 picks a free one).
   * @param {string} [host] - Host/interface to bind.
   * @returns {Promise<{port: number, host: string}>} The bound address.
   */
  listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        const address = this.server.address();
        resolve({ port: address.port, host: address.address });
      });
    });
  }

  /** @returns {string} The base URL once listening. */
  get url() {
    const address = this.server.address();
    if (!address) {
      throw new Error('Server is not listening');
    }
    const host = address.address === '::' ? '127.0.0.1' : address.address;
    return `http://${host}:${address.port}`;
  }

  /**
   * Stop the server.
   *
   * @returns {Promise<void>} Resolves once closed.
   */
  close() {
    this.subscriptions.dispose();
    return new Promise((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

/**
 * Convenience factory that builds and starts a server in one call.
 *
 * @param {object} [options] - Forwarded to {@link LinksQLServer} plus `port`/`host`.
 * @returns {Promise<LinksQLServer>} The listening server.
 */
export async function startServer(options = {}) {
  const server = new LinksQLServer(options);
  await server.listen(options.port, options.host);
  return server;
}
