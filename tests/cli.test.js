/**
 * Tests for the `linksql` command-line interface.
 *
 * The `query`, `--version` and help paths are pure and run everywhere. The
 * `--db`/`import` paths write files and `serve` binds a port, so those run on
 * Node and Bun only — Deno CI grants `--allow-read` but not write/network.
 */

import { describe, it, expect } from 'test-anywhere';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { runCli } from '../bin/linksql.js';

const isDenoRuntime = typeof Deno !== 'undefined';

/** Capture stdout/stderr lines for assertions. */
function capture() {
  const out = [];
  const err = [];
  return {
    io: {
      stdout: (message) => out.push(message),
      stderr: (message) => err.push(message),
    },
    out,
    err,
  };
}

describe('CLI', () => {
  it('prints the version', async () => {
    const { io, out } = capture();
    const code = await runCli(['--version'], io);
    expect(code).toBe(0);
    expect(out.length).toBe(1);
  });

  it('prints help when given no command', async () => {
    const { io, out } = capture();
    const code = await runCli([], io);
    expect(code).toBe(0);
    expect(out[0]).toContain('Usage: linksql');
  });

  it('runs a query and prints a JSON report', async () => {
    const { io, out } = capture();
    const code = await runCli(['query', '() ((1 1))'], io);
    expect(code).toBe(0);
    const report = JSON.parse(out[0]);
    expect(report.operation).toBe('create');
    expect(report.created.length).toBe(1);
  });

  it('reports an unknown command with a non-zero exit code', async () => {
    const { io, err } = capture();
    const code = await runCli(['frobnicate'], io);
    expect(code).toBe(1);
    expect(err[0]).toContain('Unknown command');
  });

  if (!isDenoRuntime) {
    it('persists to and reads back from a --db file', async () => {
      const dbFile = join(tmpdir(), `linksql-cli-${process.pid}.lino`);
      try {
        await runCli(['query', '() ((1 2))', '--db', dbFile], capture().io);
        expect(existsSync(dbFile)).toBe(true);

        const exported = capture();
        const code = await runCli(['export', '--db', dbFile], exported.io);
        expect(code).toBe(0);
        expect(exported.out[0]).toBe('(1: 1 2)');
      } finally {
        if (existsSync(dbFile)) {
          rmSync(dbFile);
        }
      }
    });

    it('imports LiNo from a file', async () => {
      const source = join(tmpdir(), `linksql-cli-src-${process.pid}.lino`);
      const dbFile = join(tmpdir(), `linksql-cli-db-${process.pid}.lino`);
      try {
        writeFileSync(source, '(1: 1 1)\n(2: 1 2)\n');
        const { io, out } = capture();
        const code = await runCli(['import', source, '--db', dbFile], io);
        expect(code).toBe(0);
        expect(out[0]).toContain('Imported 2');
      } finally {
        for (const file of [source, dbFile]) {
          if (existsSync(file)) {
            rmSync(file);
          }
        }
      }
    });

    it('serve returns a running server that can be closed', async () => {
      const server = await runCli(['serve', '--port', '0'], capture().io);
      expect(typeof server.close).toBe('function');
      await server.close();
    });
  }
});
