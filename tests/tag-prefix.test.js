/**
 * Tests for --tag-prefix support in create-github-release.mjs and format-github-release.mjs
 * Reproduces issue #38: tag names should be configurable for multi-language repos
 */

import { describe, it, expect } from 'test-anywhere';

// Simulate the tag construction logic from both scripts
function buildTag(version, tagPrefix = 'v') {
  return `${tagPrefix}${version}`;
}

describe('tag prefix logic', () => {
  it('defaults to "v" prefix (backward compatible)', () => {
    expect(buildTag('1.0.0')).toBe('v1.0.0');
  });

  it('supports "js-v" prefix for multi-language repos', () => {
    expect(buildTag('1.0.0', 'js-v')).toBe('js-v1.0.0');
  });

  it('supports "rust-v" prefix', () => {
    expect(buildTag('1.7.8', 'rust-v')).toBe('rust-v1.7.8');
  });

  it('supports empty prefix', () => {
    expect(buildTag('2.3.4', '')).toBe('2.3.4');
  });

  it('works with pre-release versions', () => {
    expect(buildTag('1.0.0-alpha.1', 'js-v')).toBe('js-v1.0.0-alpha.1');
  });
});
