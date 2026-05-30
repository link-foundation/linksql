/**
 * Named references.
 *
 * Link indices are convenient for machines but opaque to humans. A `Names`
 * registry maps human-readable labels to link identities (mirroring the sidecar
 * `<db>.names.links` file used by link-cli) so a query can say `(alice loves bob)`
 * instead of `(7 9 8)`.
 *
 * A freshly-named identity is materialised as a *point* — the link `(i: i i)` —
 * so that everything in the model remains a link. When `autoCreate` is disabled,
 * referring to an unknown name is an error instead, which is useful for catching
 * typos in production schemas.
 */

/** Error thrown when an unknown name is used while auto-creation is disabled. */
export class UnknownNameError extends Error {
  /** @param {string} name - The offending name. */
  constructor(name) {
    super(`Unknown named reference: ${name}`);
    this.name = 'UnknownNameError';
  }
}

/** A bidirectional registry of label <-> link-index associations. */
export class Names {
  /**
   * @param {import('./store.js').LinksStore} store - Backing links store.
   * @param {object} [options] - Behaviour flags.
   * @param {boolean} [options.autoCreate] - Allocate missing names on demand.
   */
  constructor(store, { autoCreate = true } = {}) {
    this.store = store;
    this.autoCreate = autoCreate;
    /** @type {Map<string, number>} */
    this.byName = new Map();
    /** @type {Map<number, string>} */
    this.byIndex = new Map();
  }

  /**
   * Resolve a name to its index without creating anything.
   *
   * @param {string} name - The label to look up.
   * @returns {number|undefined} The index, or `undefined` when unknown.
   */
  resolve(name) {
    return this.byName.get(name);
  }

  /**
   * Resolve a name, allocating and materialising it when permitted.
   *
   * @param {string} name - The label to ensure.
   * @returns {number} The associated index.
   */
  ensure(name) {
    const existing = this.byName.get(name);
    if (existing !== undefined) {
      return existing;
    }
    if (!this.autoCreate) {
      throw new UnknownNameError(name);
    }
    const index = this.store.allocateIndex();
    this.bind(name, index);
    if (!this.store.has(index)) {
      this.store.create({ index, source: index, target: index });
    }
    return index;
  }

  /**
   * Associate a name with an existing index (no materialisation).
   *
   * @param {string} name - The label.
   * @param {number} index - The index to bind it to.
   * @returns {number} The index.
   */
  bind(name, index) {
    this.byName.set(name, index);
    this.byIndex.set(index, name);
    this.store.reserveIndex(index);
    return index;
  }

  /**
   * Look up the label associated with an index.
   *
   * @param {number} index - The link index.
   * @returns {string|undefined} The label, or `undefined`.
   */
  nameOf(index) {
    return this.byIndex.get(index);
  }

  /** @returns {Array<[string, number]>} All `[name, index]` associations. */
  entries() {
    return [...this.byName.entries()];
  }
}
