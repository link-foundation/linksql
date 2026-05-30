/**
 * LinksQL HTTP client.
 *
 * The mirror image of {@link LinksQLServer}: a thin wrapper around `fetch` that
 * speaks the same endpoints. Like the server, it uses Links Notation as the wire
 * protocol — requests ask for `application/lino` and responses are decoded from
 * Links Notation into plain objects. Subscriptions are consumed as a
 * Server-Sent Events stream, giving the client a GraphQL-style live feed of the
 * changes that match a pattern.
 */

import { decode, LINO_CONTENT_TYPE } from './protocol.js';

/** Parse complete `data:` frames out of an SSE buffer, returning the remainder. */
function drainFrames(buffer, onEvent) {
  let rest = buffer;
  let boundary = rest.indexOf('\n\n');
  while (boundary !== -1) {
    const frame = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) {
      onEvent(decode(data));
    }
    boundary = rest.indexOf('\n\n');
  }
  return rest;
}

/** A client for a remote {@link LinksQLServer}. */
export class LinksQLClient {
  /**
   * @param {string} baseUrl - Base URL of the server, e.g. `http://localhost:8080`.
   * @param {object} [options] - Client options.
   * @param {typeof fetch} [options.fetch] - A `fetch` implementation to use.
   */
  constructor(baseUrl, { fetch: fetchImpl } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl || globalThis.fetch;
    if (typeof this.fetch !== 'function') {
      throw new Error('No fetch implementation available');
    }
  }

  /** Decode a Links Notation response, throwing on a non-2xx status. */
  async data(response) {
    const text = await response.text();
    const body = text ? decode(text) : {};
    if (!response.ok) {
      const message =
        (body && typeof body === 'object' && body.error) ||
        `Request failed: ${response.status}`;
      throw new Error(message);
    }
    return body;
  }

  /**
   * Run a query and return its report.
   *
   * @param {string} text - The LinksQL query as LiNo text.
   * @returns {Promise<object>} The structured report.
   */
  async query(text) {
    const response = await this.fetch(`${this.baseUrl}/query`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        accept: LINO_CONTENT_TYPE,
      },
      body: text,
    });
    return this.data(response);
  }

  /** @returns {Promise<Array<object>>} Every stored link. */
  async links() {
    const response = await this.fetch(`${this.baseUrl}/links`, {
      headers: { accept: LINO_CONTENT_TYPE },
    });
    const body = await this.data(response);
    return body.links;
  }

  /** @returns {Promise<object>} The server's introspection snapshot. */
  async introspect() {
    const response = await this.fetch(`${this.baseUrl}/introspect`, {
      headers: { accept: LINO_CONTENT_TYPE },
    });
    return this.data(response);
  }

  /**
   * Fetch the server's schema introspection document (its GraphQL `__schema`).
   *
   * @returns {Promise<object>} The schema introspection document.
   */
  async schema() {
    const response = await this.fetch(`${this.baseUrl}/schema`, {
      headers: { accept: LINO_CONTENT_TYPE },
    });
    return this.data(response);
  }

  /**
   * Run a query declared by name in the server's schema.
   *
   * @param {string} name - The declared query's name.
   * @returns {Promise<object>} The structured report.
   */
  async runNamed(name) {
    const response = await this.fetch(
      `${this.baseUrl}/query/${encodeURIComponent(name)}`,
      { method: 'POST', headers: { accept: LINO_CONTENT_TYPE } }
    );
    return this.data(response);
  }

  /**
   * Subscribe to a named subscription declared in the server's schema.
   *
   * @param {string} name - The declared subscription's name.
   * @param {(event: {operation: string, matching: object[]}) => void} onEvent -
   *   Invoked for every matching change.
   * @param {object} [options] - Subscription options.
   * @param {AbortSignal} [options.signal] - Caller-controlled cancellation.
   * @returns {{ready: Promise<void>, done: Promise<void>, close: () => void}}
   *   Same shape as {@link LinksQLClient#subscribe}.
   */
  subscribeNamed(name, onEvent, { signal } = {}) {
    const controller = new AbortController();
    const abortSignal = signal || controller.signal;
    const url = `${this.baseUrl}/subscribe/${encodeURIComponent(name)}`;
    let resolveReady;
    const ready = new Promise((resolve) => {
      resolveReady = resolve;
    });
    const done = this.streamEvents(
      url,
      abortSignal,
      onEvent,
      resolveReady
    ).catch((error) => {
      if (error.name !== 'AbortError') {
        throw error;
      }
    });
    return { ready, done, close: () => controller.abort() };
  }

  /**
   * Bulk-import LiNo text.
   *
   * @param {string} text - LiNo text of links to create.
   * @returns {Promise<number>} The number of links imported.
   */
  async importLino(text) {
    const response = await this.fetch(`${this.baseUrl}/import`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', accept: LINO_CONTENT_TYPE },
      body: text,
    });
    const body = await this.data(response);
    return body.imported;
  }

  /** @returns {Promise<string>} The whole database as canonical LiNo. */
  async export() {
    const response = await this.fetch(`${this.baseUrl}/export`);
    if (!response.ok) {
      throw new Error(`Export failed: ${response.status}`);
    }
    return response.text();
  }

  /**
   * Subscribe to changes that match a pattern via Server-Sent Events.
   *
   * @param {string} pattern - A restriction, e.g. `((alice $x))`.
   * @param {(event: {operation: string, matching: object[]}) => void} onEvent -
   *   Invoked for every matching change.
   * @param {object} [options] - Subscription options.
   * @param {AbortSignal} [options.signal] - Caller-controlled cancellation.
   * @returns {{ready: Promise<void>, done: Promise<void>, close: () => void}}
   *   `ready` resolves once the stream is open; `done` settles when it ends;
   *   `close` aborts it.
   */
  subscribe(pattern, onEvent, { signal } = {}) {
    const controller = new AbortController();
    const abortSignal = signal || controller.signal;
    const url = `${this.baseUrl}/subscribe?pattern=${encodeURIComponent(pattern)}`;
    let resolveReady;
    const ready = new Promise((resolve) => {
      resolveReady = resolve;
    });
    const done = this.streamEvents(
      url,
      abortSignal,
      onEvent,
      resolveReady
    ).catch((error) => {
      if (error.name !== 'AbortError') {
        throw error;
      }
    });
    return { ready, done, close: () => controller.abort() };
  }

  /** Drive the SSE read loop until the stream closes or aborts. */
  async streamEvents(url, signal, onEvent, onReady) {
    const response = await this.fetch(url, {
      signal,
      headers: { accept: 'text/event-stream' },
    });
    onReady();
    if (!response.ok || !response.body) {
      throw new Error(`Subscribe failed: ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      buffer = drainFrames(buffer, onEvent);
    }
  }
}
