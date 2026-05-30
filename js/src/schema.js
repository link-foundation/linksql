/**
 * LinksQL schemas — the GraphQL-class API layer.
 *
 * The issue asks LinksQL to be "robust enough to replace GraphQL", which means
 * offering the features developers expect from GraphQL: a declarative schema,
 * introspection, named operations and subscriptions, and the ability to generate
 * a server from a schema. This module supplies the schema; {@link
 * module:server} and {@link createSchemaServer} turn one into a running API.
 *
 * A schema is itself written in Links Notation (the data protocol), so the same
 * notation describes data *and* the shape of the API that serves it:
 *
 *   (schema social
 *     (type Person)
 *     (type Post)
 *     (relation name (from Person) (to Text))
 *     (relation author (from Post) (to Person))
 *     (relation likes (from Person) (to Post))
 *     (query everyone (($p: $p $p)))
 *     (subscription newLikes ((likes $p $post))))
 *
 * The GraphQL analogy is direct:
 *   - `type`         ⇔ object type
 *   - `relation`     ⇔ a typed field/edge (`from` → `to`)
 *   - a scalar type  ⇔ any relation endpoint that is not a declared object type
 *   - `query`        ⇔ a named, reusable read (a query template)
 *   - `subscription` ⇔ a named live feed (a restriction streamed as it changes)
 *   - `introspect()` ⇔ the `__schema` introspection document
 */

import { parse, serialize, serializeAll } from './lino.js';

/** Error thrown when a schema is malformed or violated. */
export class SchemaError extends Error {
  /** @param {string} message - Human readable description. */
  constructor(message) {
    super(message);
    this.name = 'SchemaError';
  }
}

/** The declaration keywords a schema understands. */
const KEYWORDS = Object.freeze(['type', 'relation', 'query', 'subscription']);

/**
 * Read a reference node's name as a string.
 *
 * @param {object} node - An AST node expected to be a reference.
 * @param {string} context - What is being read, for error messages.
 * @returns {string} The reference's textual value.
 */
function refName(node, context) {
  if (!node || node.type !== 'ref') {
    throw new SchemaError(`Expected a name for ${context}`);
  }
  if (node.kind === 'variable') {
    return `$${node.value}`;
  }
  return String(node.value);
}

/**
 * Find a `(keyword value)` sub-link among a declaration's values and return the
 * value's name.
 *
 * @param {object[]} values - The declaration's value nodes.
 * @param {string} keyword - The keyword to look for (e.g. `from`).
 * @param {string} context - The declaration name, for error messages.
 * @returns {string} The named argument.
 */
function namedArg(values, keyword, context) {
  for (const value of values) {
    if (
      value.type === 'link' &&
      value.values.length === 2 &&
      value.values[0].type === 'ref' &&
      String(value.values[0].value) === keyword
    ) {
      return refName(value.values[1], `${keyword} of ${context}`);
    }
  }
  throw new SchemaError(
    `Relation "${context}" is missing its "${keyword}" type`
  );
}

/**
 * Sort one declaration link into the right collection.
 *
 * @param {object} declaration - A `(keyword ...)` link node.
 * @param {object} buckets - The accumulating `{types, relations, queries,
 *   subscriptions}` collections, mutated in place.
 */
function collectDeclaration(declaration, buckets) {
  if (declaration.type !== 'link' || declaration.values.length === 0) {
    throw new SchemaError('Each schema declaration must be a link');
  }
  const keyword = refName(declaration.values[0], 'declaration keyword');
  if (!KEYWORDS.includes(keyword)) {
    throw new SchemaError(
      `Unknown schema declaration "${keyword}" (expected ${KEYWORDS.join('|')})`
    );
  }
  const rest = declaration.values.slice(1);
  if (keyword === 'type') {
    buckets.types.push(refName(rest[0], 'type name'));
  } else if (keyword === 'relation') {
    const relationName = refName(rest[0], 'relation name');
    buckets.relations.push({
      name: relationName,
      from: namedArg(rest, 'from', relationName),
      to: namedArg(rest, 'to', relationName),
    });
  } else if (keyword === 'query') {
    buckets.queries.push({
      name: refName(rest[0], 'query name'),
      text: serializeAll(rest.slice(1), ' '),
    });
  } else {
    buckets.subscriptions.push({
      name: refName(rest[0], 'subscription name'),
      pattern: serializeAll(rest.slice(1), ' '),
    });
  }
}

/**
 * Derive scalar type names: any relation endpoint not declared as an object type.
 *
 * @param {Array<{from: string, to: string}>} relations - The parsed relations.
 * @param {string[]} types - The declared object type names.
 * @returns {string[]} The inferred scalar type names, in first-seen order.
 */
function inferScalars(relations, types) {
  const scalars = [];
  for (const relation of relations) {
    for (const endpoint of [relation.from, relation.to]) {
      if (!types.includes(endpoint) && !scalars.includes(endpoint)) {
        scalars.push(endpoint);
      }
    }
  }
  return scalars;
}

/** A declarative description of a LinksQL API. */
export class Schema {
  /**
   * @param {object} definition - The parsed schema.
   * @param {string} [definition.name] - The schema's name.
   * @param {string[]} [definition.types] - Declared object type names.
   * @param {string[]} [definition.scalars] - Scalar type names (relation endpoints
   *   that are not declared object types).
   * @param {Array<{name: string, from: string, to: string}>} [definition.relations]
   *   - Typed relations (the GraphQL fields/edges).
   * @param {Array<{name: string, text: string}>} [definition.queries] - Named
   *   read templates.
   * @param {Array<{name: string, pattern: string}>} [definition.subscriptions] -
   *   Named live feeds.
   */
  constructor({
    name = null,
    types = [],
    scalars = [],
    relations = [],
    queries = [],
    subscriptions = [],
  } = {}) {
    this.name = name;
    this.types = [...types];
    this.scalars = [...scalars];
    this.relations = relations.map((relation) => ({ ...relation }));
    this.queries = queries.map((query) => ({ ...query }));
    this.subscriptions = subscriptions.map((sub) => ({ ...sub }));
  }

  /**
   * Parse a schema written in Links Notation.
   *
   * @param {string} text - The schema document.
   * @returns {Schema} The parsed schema.
   */
  static parse(text) {
    let nodes;
    try {
      nodes = parse(text);
    } catch (error) {
      throw new SchemaError(`Invalid LiNo schema: ${error.message}`);
    }
    if (nodes.length !== 1 || nodes[0].type !== 'link') {
      throw new SchemaError('A schema must be a single `(schema ...)` link');
    }
    const root = nodes[0];
    const values = [...root.values];
    const head = values.shift();
    if (!head || head.type !== 'ref' || String(head.value) !== 'schema') {
      throw new SchemaError('A schema must start with the `schema` keyword');
    }
    // An optional bare name may follow the `schema` keyword.
    let name = null;
    if (values.length > 0 && values[0].type === 'ref') {
      name = refName(values.shift(), 'schema name');
    }

    const buckets = {
      types: [],
      relations: [],
      queries: [],
      subscriptions: [],
    };
    for (const declaration of values) {
      collectDeclaration(declaration, buckets);
    }
    const { types, relations, queries, subscriptions } = buckets;
    const scalars = inferScalars(relations, types);

    return new Schema({
      name,
      types,
      scalars,
      relations,
      queries,
      subscriptions,
    });
  }

  /**
   * Look up a relation by name.
   *
   * @param {string} name - The relation name.
   * @returns {{name: string, from: string, to: string}|undefined} The relation.
   */
  relation(name) {
    return this.relations.find((relation) => relation.name === name);
  }

  /**
   * Look up a named query.
   *
   * @param {string} name - The query name.
   * @returns {{name: string, text: string}|undefined} The query template.
   */
  query(name) {
    return this.queries.find((query) => query.name === name);
  }

  /**
   * Look up a named subscription.
   *
   * @param {string} name - The subscription name.
   * @returns {{name: string, pattern: string}|undefined} The subscription.
   */
  subscription(name) {
    return this.subscriptions.find((sub) => sub.name === name);
  }

  /**
   * Whether a name is a declared type, scalar or relation.
   *
   * @param {string} name - The name to test.
   * @returns {boolean} True when the schema declares it.
   */
  knows(name) {
    return (
      this.types.includes(name) ||
      this.scalars.includes(name) ||
      this.relations.some((relation) => relation.name === name)
    );
  }

  /**
   * Assert that a relation is declared, throwing otherwise.
   *
   * @param {string} name - The relation name to validate.
   * @returns {{name: string, from: string, to: string}} The relation.
   */
  validateRelation(name) {
    const relation = this.relation(name);
    if (!relation) {
      throw new SchemaError(`Unknown relation "${name}"`);
    }
    return relation;
  }

  /**
   * Describe the schema for introspection tooling — the GraphQL `__schema`
   * analogue. The returned value is JSON-shaped and therefore travels over the
   * wire as Links Notation like every other payload.
   *
   * @returns {object} The introspection document.
   */
  introspect() {
    return {
      name: this.name,
      types: [...this.types],
      scalars: [...this.scalars],
      relations: this.relations.map((relation) => ({ ...relation })),
      queries: this.queries.map((query) => ({ ...query })),
      subscriptions: this.subscriptions.map((sub) => ({ ...sub })),
    };
  }

  /**
   * Render the schema back to canonical Links Notation.
   *
   * @returns {string} The schema as a `(schema ...)` document.
   */
  toLino() {
    const declarations = [];
    for (const type of this.types) {
      declarations.push(
        `(type ${serialize({ type: 'ref', kind: 'name', value: type })})`
      );
    }
    for (const relation of this.relations) {
      declarations.push(
        `(relation ${relation.name} (from ${relation.from}) (to ${relation.to}))`
      );
    }
    for (const query of this.queries) {
      declarations.push(`(query ${query.name} ${query.text})`);
    }
    for (const sub of this.subscriptions) {
      declarations.push(`(subscription ${sub.name} ${sub.pattern})`);
    }
    const head = this.name ? `schema ${this.name}` : 'schema';
    return `(${[head, ...declarations].join(' ')})`;
  }
}
