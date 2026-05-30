/**
 * In-memory doublets store.
 *
 * The associative data model used by LinksQL is built from a single primitive:
 * the **link** (a doublet). Every link is a triple
 *
 *   (index: source target)
 *
 * where `index` is the link's own unique identity and `source`/`target` are the
 * indices of the linked links. A link whose source and target both equal its own
 * index is a *point* — the atomic node of the graph.
 *
 * The store owns identity allocation and enforces the associative invariant that
 * a `(source, target)` pair identifies at most one link (deduplication). It is a
 * pure data container: pattern matching and the substitution operation live in
 * `substitution.js`, which only relies on the read/write surface defined here.
 */

/** Error thrown when a store operation would violate model integrity. */
export class LinkIntegrityError extends Error {
  /** @param {string} message - Human readable description. */
  constructor(message) {
    super(message);
    this.name = 'LinkIntegrityError';
  }
}

/**
 * Build the deduplication key for a `(source, target)` pair.
 *
 * @param {number} source - Source index.
 * @param {number} target - Target index.
 * @returns {string} Map key.
 */
function pairKey(source, target) {
  return `${source},${target}`;
}

/** A mutable set of links addressed by integer identity. */
export class LinksStore {
  constructor() {
    /** @type {Map<number, {index: number, source: number, target: number}>} */
    this.links = new Map();
    /** @type {Map<string, number>} */
    this.byPair = new Map();
    /** Next identity to hand out; kept above every used index. */
    this.nextIndex = 1;
  }

  /** @returns {number} Number of stored links. */
  get size() {
    return this.links.size;
  }

  /**
   * @param {number} index - Identity to test.
   * @returns {boolean} Whether a link with this identity exists.
   */
  has(index) {
    return this.links.has(index);
  }

  /**
   * @param {number} index - Identity to fetch.
   * @returns {{index: number, source: number, target: number}|undefined} Link.
   */
  get(index) {
    return this.links.get(index);
  }

  /**
   * Look up a link by its `(source, target)` structure.
   *
   * @param {number} source - Source index.
   * @param {number} target - Target index.
   * @returns {{index: number, source: number, target: number}|undefined} Link.
   */
  findByPair(source, target) {
    const index = this.byPair.get(pairKey(source, target));
    return index === undefined ? undefined : this.links.get(index);
  }

  /** @returns {Array<{index: number, source: number, target: number}>} All links. */
  all() {
    return [...this.links.values()];
  }

  /**
   * Reserve a fresh identity, advancing the allocator past it.
   *
   * @returns {number} A previously-unused index.
   */
  allocateIndex() {
    while (this.links.has(this.nextIndex)) {
      this.nextIndex += 1;
    }
    return this.nextIndex++;
  }

  /**
   * Keep the allocator above an externally chosen identity.
   *
   * @param {number} index - An index that is now in use.
   */
  reserveIndex(index) {
    if (index >= this.nextIndex) {
      this.nextIndex = index + 1;
    }
  }

  /**
   * Create (or, by deduplication, return) a link.
   *
   * @param {object} spec - Link specification.
   * @param {number} [spec.index] - Explicit identity; auto-allocated when absent.
   * @param {number} spec.source - Source index.
   * @param {number} spec.target - Target index.
   * @returns {{index: number, source: number, target: number}} The link.
   */
  create({ index, source, target }) {
    if (!Number.isInteger(source) || !Number.isInteger(target)) {
      throw new LinkIntegrityError('Link source and target must be integers');
    }
    const existing = this.findByPair(source, target);
    if (existing) {
      if (index !== undefined && index !== existing.index) {
        throw new LinkIntegrityError(
          `Link (${source} ${target}) already exists as ${existing.index}, ` +
            `cannot also be ${index}`
        );
      }
      return existing;
    }
    let id = index;
    if (id === undefined) {
      id = this.allocateIndex();
    } else {
      if (!Number.isInteger(id) || id < 1) {
        throw new LinkIntegrityError('Link index must be a positive integer');
      }
      if (this.links.has(id)) {
        throw new LinkIntegrityError(`Link index ${id} is already in use`);
      }
      this.reserveIndex(id);
    }
    const link = { index: id, source, target };
    this.links.set(id, link);
    this.byPair.set(pairKey(source, target), id);
    return link;
  }

  /**
   * Replace the structure of an existing link, preserving its identity unless a
   * new identity is requested.
   *
   * @param {number} index - Identity of the link to update.
   * @param {object} spec - New structure.
   * @param {number} spec.source - New source index.
   * @param {number} spec.target - New target index.
   * @param {number} [spec.newIndex] - Optional new identity (re-index).
   * @returns {{index: number, source: number, target: number}} Updated link.
   */
  update(index, { source, target, newIndex }) {
    const current = this.links.get(index);
    if (!current) {
      throw new LinkIntegrityError(`Cannot update missing link ${index}`);
    }
    const id = newIndex === undefined ? index : newIndex;
    const collision = this.findByPair(source, target);
    if (collision && collision.index !== index) {
      throw new LinkIntegrityError(
        `Cannot update link ${index}: (${source} ${target}) already exists ` +
          `as ${collision.index}`
      );
    }
    if (id !== index && this.links.has(id)) {
      throw new LinkIntegrityError(`Link index ${id} is already in use`);
    }
    this.byPair.delete(pairKey(current.source, current.target));
    this.links.delete(index);
    const link = { index: id, source, target };
    this.links.set(id, link);
    this.byPair.set(pairKey(source, target), id);
    this.reserveIndex(id);
    return link;
  }

  /**
   * Remove a link by identity.
   *
   * @param {number} index - Identity to remove.
   * @returns {boolean} Whether a link was removed.
   */
  delete(index) {
    const current = this.links.get(index);
    if (!current) {
      return false;
    }
    this.byPair.delete(pairKey(current.source, current.target));
    this.links.delete(index);
    return true;
  }

  /** Remove every link and reset identity allocation. */
  clear() {
    this.links.clear();
    this.byPair.clear();
    this.nextIndex = 1;
  }
}
