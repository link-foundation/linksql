/**
 * Links Notation (LiNo) parser and serializer.
 *
 * LiNo represents associative data as nested links. Every link has the form
 *
 *   (index: source target)
 *
 * where `index` (the identity) is optional and the values (`source`, `target`,
 * ...) are themselves references or links. The notation is the surface syntax
 * for the LinksQL substitution model.
 *
 * The grammar implemented here is:
 *
 *   document = { value } ;
 *   value    = link | reference ;
 *   link     = "(" [ value ":" ] { value } ")" ;
 *   reference = number | name | variable | wildcard | string ;
 *   variable = "$" name ;
 *   wildcard = "*" ;
 *
 * The parser produces a small, explicit AST so the rest of the engine never
 * has to re-tokenize text.
 */

/** Error thrown when LiNo input cannot be parsed. */
export class LinoSyntaxError extends Error {
  /**
   * @param {string} message - Human readable description.
   * @param {number} position - Zero-based offset of the offending character.
   */
  constructor(message, position) {
    super(position >= 0 ? `${message} (at position ${position})` : message);
    this.name = 'LinoSyntaxError';
    this.position = position;
  }
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);
const DELIMITERS = new Set(['(', ')', ':', '"', "'"]);

/** Characters that force a name to be quoted on output. */
const QUOTE_REQUIRED = /[\s():"']/;

/**
 * Classify a bareword (a run of non-delimiter characters) into a reference
 * token. Numbers become numeric references, `$x` becomes a variable, `*`
 * becomes a wildcard, and everything else becomes a name.
 *
 * @param {string} word - The raw bareword.
 * @param {number} pos - Source offset for diagnostics.
 * @returns {object} A reference token.
 */
function classifyWord(word, pos) {
  if (word === '*') {
    return { type: 'ref', refKind: 'wildcard', value: '*', pos };
  }
  if (word[0] === '$') {
    return { type: 'ref', refKind: 'variable', value: word.slice(1), pos };
  }
  if (/^\d+$/.test(word)) {
    return { type: 'ref', refKind: 'number', value: Number(word), pos };
  }
  return { type: 'ref', refKind: 'name', value: word, pos };
}

/**
 * Read a quoted string starting at `start` (which points at the quote).
 *
 * @param {string} input - Full source text.
 * @param {number} start - Index of the opening quote.
 * @returns {{ token: object, next: number }} The string token and next index.
 */
function readString(input, start) {
  const quote = input[start];
  let i = start + 1;
  let value = '';
  while (i < input.length && input[i] !== quote) {
    if (input[i] === '\\' && i + 1 < input.length) {
      value += input[i + 1];
      i += 2;
    } else {
      value += input[i];
      i += 1;
    }
  }
  if (i >= input.length) {
    throw new LinoSyntaxError('Unterminated quoted string', start);
  }
  return {
    token: { type: 'ref', refKind: 'name', value, pos: start, quoted: true },
    next: i + 1,
  };
}

/**
 * Split LiNo source text into a flat list of tokens.
 *
 * @param {string} input - LiNo source text.
 * @returns {object[]} Ordered tokens.
 */
export function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (WHITESPACE.has(ch)) {
      i += 1;
    } else if (ch === '(') {
      tokens.push({ type: 'lparen', pos: i });
      i += 1;
    } else if (ch === ')') {
      tokens.push({ type: 'rparen', pos: i });
      i += 1;
    } else if (ch === ':') {
      tokens.push({ type: 'colon', pos: i });
      i += 1;
    } else if (ch === '"' || ch === "'") {
      const { token, next } = readString(input, i);
      tokens.push(token);
      i = next;
    } else {
      const start = i;
      let word = '';
      while (i < input.length && !WHITESPACE.has(input[i])) {
        if (DELIMITERS.has(input[i])) {
          break;
        }
        word += input[i];
        i += 1;
      }
      tokens.push(classifyWord(word, start));
    }
  }
  return tokens;
}

/** @param {object} state - Parser cursor. */
function peek(state) {
  return state.tokens[state.index];
}

/** @param {object} state - Parser cursor. */
function advance(state) {
  return state.tokens[state.index++];
}

/**
 * Build a reference AST node from a reference token.
 *
 * @param {object} token - A token of type `ref`.
 * @returns {object} Reference node.
 */
function referenceNode(token) {
  return { type: 'ref', kind: token.refKind, value: token.value };
}

/**
 * Parse a single value (a reference or a parenthesized link).
 *
 * @param {object} state - Parser cursor.
 * @returns {object} AST node.
 */
function parseValue(state) {
  const token = peek(state);
  if (!token) {
    throw new LinoSyntaxError('Unexpected end of input', -1);
  }
  if (token.type === 'lparen') {
    return parseLink(state);
  }
  if (token.type === 'ref') {
    advance(state);
    return referenceNode(token);
  }
  throw new LinoSyntaxError(`Unexpected '${token.type}'`, token.pos);
}

/**
 * Parse a link: `(` [ value `:` ] values... `)`.
 *
 * @param {object} state - Parser cursor.
 * @returns {object} Link node.
 */
function parseLink(state) {
  advance(state); // consume '('
  if (peek(state) && peek(state).type === 'rparen') {
    advance(state);
    return { type: 'link', id: null, values: [] };
  }
  const first = parseValue(state);
  let id = null;
  const values = [];
  if (peek(state) && peek(state).type === 'colon') {
    advance(state); // consume ':'
    id = first;
  } else {
    values.push(first);
  }
  while (peek(state) && peek(state).type !== 'rparen') {
    values.push(parseValue(state));
  }
  const closing = peek(state);
  if (!closing || closing.type !== 'rparen') {
    throw new LinoSyntaxError('Expected )', closing ? closing.pos : -1);
  }
  advance(state); // consume ')'
  return { type: 'link', id, values };
}

/**
 * Parse LiNo source text into an array of top-level AST nodes.
 *
 * @param {string} input - LiNo source text.
 * @returns {object[]} Top-level nodes (links and references).
 */
export function parse(input) {
  if (typeof input !== 'string') {
    throw new LinoSyntaxError('LiNo input must be a string', -1);
  }
  const state = { tokens: tokenize(input), index: 0 };
  const values = [];
  while (state.index < state.tokens.length) {
    values.push(parseValue(state));
  }
  return values;
}

/**
 * Quote a name for output if it contains characters that would otherwise be
 * interpreted as structure.
 *
 * @param {string} name - Raw name.
 * @returns {string} Possibly quoted name.
 */
function quoteName(name) {
  if (name === '' || QUOTE_REQUIRED.test(name)) {
    return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return name;
}

/**
 * Serialize a reference node to LiNo text.
 *
 * @param {object} node - Reference node.
 * @returns {string} LiNo text.
 */
function serializeRef(node) {
  if (node.kind === 'variable') {
    return `$${node.value}`;
  }
  if (node.kind === 'wildcard') {
    return '*';
  }
  if (node.kind === 'number') {
    return String(node.value);
  }
  return quoteName(String(node.value));
}

/**
 * Serialize an AST node (reference or link) back to LiNo text.
 *
 * @param {object} node - AST node.
 * @returns {string} LiNo text.
 */
export function serialize(node) {
  if (node.type === 'ref') {
    return serializeRef(node);
  }
  const parts = node.values.map(serialize);
  const body = parts.join(' ');
  if (node.id !== null && node.id !== undefined) {
    const id = serialize(node.id);
    return body ? `(${id}: ${body})` : `(${id}:)`;
  }
  return `(${body})`;
}

/**
 * Serialize an array of top-level nodes to LiNo text, one node per joiner.
 *
 * @param {object[]} nodes - Top-level nodes.
 * @param {string} [joiner] - Separator between nodes (default newline).
 * @returns {string} LiNo text.
 */
export function serializeAll(nodes, joiner = '\n') {
  return nodes.map(serialize).join(joiner);
}
