/**
 * Tests for the Links Notation wire protocol.
 *
 * Links Notation — not JSON — is the data transfer format. These tests pin the
 * round-trip behaviour of {@link encode}/{@link decode} (including the exact
 * report shape the engine produces) and the content negotiation that lets a
 * caller opt into the JSON projection.
 */

import { describe, it, expect } from 'test-anywhere';
import {
  encode,
  decode,
  prefersJson,
  LINO_CONTENT_TYPE,
} from '../src/protocol.js';

describe('Links Notation protocol', () => {
  it('encodes a query report to Links Notation', () => {
    const report = {
      operation: 'update',
      matched: [
        {
          links: [{ index: 1, source: 1, target: 1 }],
          binding: { s: 1, t: 2 },
        },
      ],
      created: [],
      updated: [{ index: 3, source: 1, target: 4 }],
      deleted: [],
    };
    const lino = encode(report);
    expect(lino).toBe(
      '((operation update) (matched (((links (((index 1) (source 1) ' +
        '(target 1)))) (binding ((s 1) (t 2)))))) (created ()) (updated ' +
        '(((index 3) (source 1) (target 4)))) (deleted ()))'
    );
  });

  it('round-trips an arbitrary report through Links Notation', () => {
    const report = {
      operation: 'create',
      matched: [],
      created: [{ index: 1, source: 1, target: 1 }],
      updated: [],
      deleted: [],
    };
    expect(decode(encode(report))).toEqual(report);
  });

  it('encodes an empty object as ()', () => {
    expect(encode({})).toBe('()');
  });

  it('prefers Links Notation unless JSON is explicitly requested', () => {
    expect(prefersJson(undefined)).toBe(false);
    expect(prefersJson(LINO_CONTENT_TYPE)).toBe(false);
    expect(prefersJson('text/plain')).toBe(false);
    expect(prefersJson('application/json')).toBe(true);
    expect(prefersJson('text/json')).toBe(true);
    // Links Notation wins when both are present.
    expect(prefersJson(`${LINO_CONTENT_TYPE}, application/json`)).toBe(false);
  });
});
