/**
 * Tests for the Links Notation (LiNo) parser and serializer.
 */

import { describe, it, expect } from 'test-anywhere';
import {
  parse,
  serialize,
  serializeAll,
  tokenize,
  LinoSyntaxError,
} from '../src/lino.js';

describe('tokenize', () => {
  it('splits structure and words', () => {
    const kinds = tokenize('(1: 1 1)').map((t) => t.type);
    expect(kinds).toEqual(['lparen', 'ref', 'colon', 'ref', 'ref', 'rparen']);
  });

  it('reads quoted strings with escapes', () => {
    const tokens = tokenize('"a\\"b"');
    expect(tokens.length).toBe(1);
    expect(tokens[0].value).toBe('a"b');
  });
});

describe('parse', () => {
  it('classifies references', () => {
    expect(parse('1')[0]).toEqual({ type: 'ref', kind: 'number', value: 1 });
    expect(parse('$x')[0]).toEqual({
      type: 'ref',
      kind: 'variable',
      value: 'x',
    });
    expect(parse('*')[0]).toEqual({
      type: 'ref',
      kind: 'wildcard',
      value: '*',
    });
    expect(parse('alice')[0]).toEqual({
      type: 'ref',
      kind: 'name',
      value: 'alice',
    });
  });

  it('parses a link with an explicit identity', () => {
    const [node] = parse('(1: 1 1)');
    expect(node.type).toBe('link');
    expect(node.id).toEqual({ type: 'ref', kind: 'number', value: 1 });
    expect(node.values.length).toBe(2);
  });

  it('parses the empty link', () => {
    expect(parse('()')[0]).toEqual({ type: 'link', id: null, values: [] });
  });

  it('parses a two-value query into two top-level nodes', () => {
    const nodes = parse('() ((1 1))');
    expect(nodes.length).toBe(2);
    expect(nodes[0].values.length).toBe(0);
    expect(nodes[1].values.length).toBe(1);
  });

  it('parses nested links', () => {
    const [node] = parse('((1 2) (3 4))');
    expect(node.values[0].type).toBe('link');
    expect(node.values[1].type).toBe('link');
  });

  it('rejects non-string input', () => {
    expect(() => parse(42)).toThrow();
  });

  it('rejects unterminated strings', () => {
    expect(() => parse('"abc')).toThrow();
  });

  it('rejects unbalanced parentheses', () => {
    expect(() => parse('(1 2')).toThrow();
  });

  it('reports a LinoSyntaxError instance', () => {
    let caught;
    try {
      parse('(1 2');
    } catch (error) {
      caught = error;
    }
    expect(caught instanceof LinoSyntaxError).toBe(true);
  });
});

describe('serialize round-trips', () => {
  const samples = [
    '1',
    '(1: 1 1)',
    '() ((1 1))',
    '((1: 1 1)) ((1: 1 2))',
    '((1 2)) ()',
    '((($i: $s $t)) (($i: $s $t)))',
    '(parent (child grandchild))',
  ];

  for (const sample of samples) {
    it(`round-trips ${sample}`, () => {
      const nodes = parse(sample);
      const text = serializeAll(nodes, ' ');
      expect(text).toBe(sample);
      // Re-parsing the output yields the same AST.
      expect(parse(text)).toEqual(nodes);
    });
  }

  it('quotes names that contain structure characters', () => {
    const [node] = parse('(name: "hello world")');
    expect(serialize(node)).toBe('(name: "hello world")');
  });
});
