import { describe, it, expect } from 'test-anywhere';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { runCli } from '../bin/linksql.js';
import { decode } from '../src/protocol.js';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const lockJson = JSON.parse(readFileSync('package-lock.json', 'utf8'));

describe('publishable package metadata', () => {
  it('uses the @link-foundation/linksql package name', () => {
    expect(packageJson.name).toBe('@link-foundation/linksql');
    expect(packageJson.publishConfig).toEqual({ access: 'public' });
    expect(lockJson.name).toBe('@link-foundation/linksql');
    expect(lockJson.packages[''].name).toBe('@link-foundation/linksql');
  });

  it('defines a globally installable CLI command', () => {
    expect(packageJson.bin).toEqual({
      linksql: './bin/linksql.js',
    });
    expect(existsSync('bin/linksql.js')).toBe(true);
  });

  it('runs a query through the CLI command', async () => {
    const stdout = [];
    const stderr = [];

    const code = await runCli(['query', '() ((1 1))'], {
      stderr: (line) => stderr.push(line),
      stdout: (line) => stdout.push(line),
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const report = decode(stdout[0]);
    expect(report.operation).toBe('create');
    expect(report.created).toEqual([{ index: 1, source: 1, target: 1 }]);
  });

  it('runs when invoked through an npm-style bin symlink', () => {
    if (typeof Deno !== 'undefined') {
      return;
    }

    const tempRoot = mkdtempSync(join(tmpdir(), 'linksql-'));
    const linkPath = join(tempRoot, 'linksql');

    try {
      symlinkSync(resolve('bin/linksql.js'), linkPath);
    } catch (error) {
      rmSync(tempRoot, { force: true, recursive: true });

      if (process.platform === 'win32') {
        expect(error.code).toBe('EPERM');
        return;
      }

      throw error;
    }

    try {
      const result = spawnSync(
        process.execPath,
        [linkPath, 'query', '() ((1 1))'],
        {
          encoding: 'utf8',
        }
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const report = decode(result.stdout);
      expect(report.operation).toBe('create');
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it('publishes only the package runtime surface', () => {
    expect(packageJson.files).toEqual([
      'bin/',
      'src/',
      'CHANGELOG.md',
      'LICENSE',
      'README.md',
    ]);
  });
});
