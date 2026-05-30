/**
 * The single substitution operation.
 *
 * LinksQL has exactly one operation. A query is a pair of pattern lists — a
 * **restriction** and a **substitution** — written `(restriction) (substitution)`.
 * The restriction selects existing links (binding variables along the way); the
 * substitution describes what those links become. The four CRUD behaviours are
 * not separate primitives, they are derived from how the two lists line up:
 *
 *   create  `()        ((s t))`   empty restriction, one created link
 *   read    `((p))`                restriction only, no mutation
 *   update  `((a b))    ((a c))`   matched link rewritten in place
 *   delete  `((a b))    ()`        matched link with no replacement is removed
 *
 * Patterns are paired positionally: restriction[i] becomes substitution[i]. Any
 * trailing restriction patterns are deletions, any trailing substitution patterns
 * are creations. This positional pairing, combined with variables, makes the
 * operation a Markov algorithm over the link space — and therefore Turing
 * complete.
 */

/** Error thrown when a substitution cannot be carried out. */
export class SubstitutionError extends Error {
  /** @param {string} message - Human readable description. */
  constructor(message) {
    super(message);
    this.name = 'SubstitutionError';
  }
}

/**
 * Decompose a link pattern node into its three slots.
 *
 * A doublet pattern is `(id: source target)`. The identity slot is optional, and
 * a pattern may also be written `()` (match anything) or `(id)` (match a single
 * identity, any structure).
 *
 * @param {object} node - A `link` AST node.
 * @returns {{id: object|null, source: object|null, target: object|null}} Slots.
 */
export function linkSlots(node) {
  if (node.type !== 'link') {
    throw new SubstitutionError(
      'Each restriction/substitution pattern must be a link'
    );
  }
  const { id, values } = node;
  if (values.length === 2) {
    return { id, source: values[0], target: values[1] };
  }
  if (values.length === 0) {
    return { id, source: null, target: null };
  }
  if (values.length === 1 && id === null) {
    return { id: values[0], source: null, target: null };
  }
  throw new SubstitutionError(
    `A link pattern must have 0 or 2 values (got ${values.length})`
  );
}

/**
 * Resolve a value node to a concrete link index for *matching* purposes.
 *
 * @param {object} node - Reference or nested link node.
 * @param {object} binding - Current variable bindings.
 * @param {object} ctx - Execution context (`store`, `names`).
 * @returns {number|undefined} The index, or `undefined` when it cannot resolve.
 */
function resolveForMatch(node, binding, ctx) {
  if (node.type === 'ref') {
    if (node.kind === 'number') {
      return node.value;
    }
    if (node.kind === 'name') {
      return ctx.names ? ctx.names.resolve(node.value) : undefined;
    }
    return undefined; // variables and wildcards are handled by the caller
  }
  const slots = linkSlots(node);
  const source = resolveForMatch(slots.source, binding, ctx);
  const target = resolveForMatch(slots.target, binding, ctx);
  if (source === undefined || target === undefined) {
    return undefined;
  }
  const found = ctx.store.findByPair(source, target);
  return found ? found.index : undefined;
}

/**
 * Constrain one slot of a pattern against an actual value, updating bindings.
 *
 * @param {object|null} slot - The slot node (`null` means "match anything").
 * @param {number} actual - The link's value at this slot.
 * @param {object} binding - Mutable bindings for the current row.
 * @param {object} ctx - Execution context.
 * @returns {boolean} Whether the slot is satisfied.
 */
function matchSlot(slot, actual, binding, ctx) {
  if (slot === null) {
    return true;
  }
  if (slot.type === 'ref') {
    if (slot.kind === 'wildcard') {
      return true;
    }
    if (slot.kind === 'variable') {
      if (Object.prototype.hasOwnProperty.call(binding, slot.value)) {
        return binding[slot.value] === actual;
      }
      binding[slot.value] = actual;
      return true;
    }
  }
  const expected = resolveForMatch(slot, binding, ctx);
  return expected !== undefined && expected === actual;
}

/**
 * Test a single pattern against a single link, extending the binding in place.
 *
 * @param {object} pattern - Link pattern node.
 * @param {object} link - A stored link.
 * @param {object} binding - Mutable bindings.
 * @param {object} ctx - Execution context.
 * @returns {boolean} Whether the link matches the pattern.
 */
function matchOne(pattern, link, binding, ctx) {
  const { id, source, target } = linkSlots(pattern);
  return (
    matchSlot(id, link.index, binding, ctx) &&
    matchSlot(source, link.source, binding, ctx) &&
    matchSlot(target, link.target, binding, ctx)
  );
}

/**
 * Join all restriction patterns into a set of binding rows. Each row records the
 * concrete link matched by every pattern, in order, so the substitution can pair
 * with them positionally.
 *
 * @param {object[]} patterns - Restriction pattern nodes.
 * @param {object} ctx - Execution context.
 * @param {object[]} snapshot - The links to match against (pre-mutation).
 * @returns {Array<{binding: object, links: object[]}>} Binding rows.
 */
function joinRestriction(patterns, ctx, snapshot) {
  let rows = [{ binding: {}, links: [] }];
  for (const pattern of patterns) {
    const next = [];
    for (const row of rows) {
      for (const link of snapshot) {
        const binding = { ...row.binding };
        if (matchOne(pattern, link, binding, ctx)) {
          next.push({ binding, links: [...row.links, link] });
        }
      }
    }
    rows = next;
  }
  return rows;
}

/**
 * Resolve a value node to a concrete index when *producing* output. Unlike
 * matching, every reference must resolve: unbound variables and wildcards are
 * errors, and names are auto-created when the context allows it.
 *
 * @param {object} node - Reference or nested link node.
 * @param {object} binding - Variable bindings for the row.
 * @param {object} ctx - Execution context.
 * @param {object[]} created - Accumulator for links created as a side effect.
 * @returns {number} The resolved index.
 */
function resolveForOutput(node, binding, ctx, created) {
  if (node.type === 'ref') {
    if (node.kind === 'number') {
      return node.value;
    }
    if (node.kind === 'variable') {
      if (!Object.prototype.hasOwnProperty.call(binding, node.value)) {
        throw new SubstitutionError(
          `Unbound variable $${node.value} in substitution`
        );
      }
      return binding[node.value];
    }
    if (node.kind === 'wildcard') {
      throw new SubstitutionError('Wildcard * cannot appear in a substitution');
    }
    if (!ctx.names) {
      throw new SubstitutionError(
        `Named reference "${node.value}" requires names to be enabled`
      );
    }
    return ctx.names.ensure(node.value);
  }
  const slots = linkSlots(node);
  if (slots.source === null || slots.target === null) {
    throw new SubstitutionError('Nested link must have a source and a target');
  }
  const source = resolveForOutput(slots.source, binding, ctx, created);
  const target = resolveForOutput(slots.target, binding, ctx, created);
  const index =
    slots.id === null
      ? undefined
      : resolveForOutput(slots.id, binding, ctx, created);
  const existing = ctx.store.findByPair(source, target);
  if (existing) {
    return existing.index;
  }
  const link = ctx.store.create({ index, source, target });
  created.push(link);
  return link.index;
}

/**
 * Turn a substitution pattern into a concrete `{index?, source, target}` spec.
 *
 * @param {object} pattern - Substitution pattern node.
 * @param {object} binding - Variable bindings for the row.
 * @param {object} ctx - Execution context.
 * @param {object[]} created - Accumulator for nested-link side effects.
 * @param {object} [matched] - The link being rewritten (for an update).
 * @returns {{index: number|undefined, source: number, target: number}} Spec.
 */
function materialize(pattern, binding, ctx, created, matched) {
  const slots = linkSlots(pattern);
  const index =
    slots.id === null
      ? undefined
      : resolveForOutput(slots.id, binding, ctx, created);
  if (slots.source === null || slots.target === null) {
    if (!matched) {
      throw new SubstitutionError(
        'A created link must specify a source and a target'
      );
    }
    return { index, source: matched.source, target: matched.target };
  }
  const source = resolveForOutput(slots.source, binding, ctx, created);
  const target = resolveForOutput(slots.target, binding, ctx, created);
  return { index, source, target };
}

/**
 * Match a restriction against the store without mutating anything.
 *
 * This is the read path: a query with a restriction but no substitution returns
 * its matches verbatim. Keeping it separate from {@link execute} is what lets a
 * lone restriction mean "read" rather than "delete".
 *
 * @param {object[]} restriction - Restriction pattern nodes.
 * @param {object} ctx - Execution context (`store`, optional `names`).
 * @returns {Array<{binding: object, links: object[]}>} Binding rows.
 */
export function match(restriction, ctx) {
  return joinRestriction(restriction, ctx, ctx.store.all());
}

/**
 * Execute one substitution operation against the store.
 *
 * @param {object[]} restriction - Restriction pattern nodes.
 * @param {object[]} substitution - Substitution pattern nodes.
 * @param {object} ctx - Execution context (`store`, optional `names`).
 * @returns {{matches: Array, created: object[], updated: object[],
 *   deleted: object[]}} A report of everything that matched and changed.
 */
export function execute(restriction, substitution, ctx) {
  const snapshot = ctx.store.all();
  const rows = joinRestriction(restriction, ctx, snapshot);
  const result = { matches: [], created: [], updated: [], deleted: [] };
  const paired = Math.min(restriction.length, substitution.length);

  for (const row of rows) {
    result.matches.push({ binding: row.binding, links: row.links });

    for (let i = 0; i < paired; i += 1) {
      const matched = row.links[i];
      if (!ctx.store.has(matched.index)) {
        continue; // already removed by an earlier row
      }
      const spec = materialize(
        substitution[i],
        row.binding,
        ctx,
        result.created,
        matched
      );
      result.updated.push(
        ctx.store.update(matched.index, {
          source: spec.source,
          target: spec.target,
          newIndex: spec.index,
        })
      );
    }

    for (let i = paired; i < restriction.length; i += 1) {
      const matched = row.links[i];
      if (ctx.store.delete(matched.index)) {
        result.deleted.push(matched);
      }
    }

    for (let i = paired; i < substitution.length; i += 1) {
      const spec = materialize(
        substitution[i],
        row.binding,
        ctx,
        result.created
      );
      result.created.push(ctx.store.create(spec));
    }
  }

  return result;
}
