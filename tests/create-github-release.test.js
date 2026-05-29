/**
 * Tests for create-github-release.mjs CLI behavior.
 * Reproduces issue #49: failed gh api calls must not be reported as success.
 * Reproduces issue #52: release names should be human-readable titles.
 */

import { describe, it, expect } from 'test-anywhere';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import {
  buildReleasePayload,
  createRelease,
  parseArgs,
} from '../scripts/create-github-release.mjs';

const scriptPath = fileURLToPath(
  new URL('../scripts/create-github-release.mjs', import.meta.url)
);
const isDenoRuntime = typeof Deno !== 'undefined';
const isBunRuntime =
  typeof process !== 'undefined' && Boolean(process.versions?.bun);
const isNodeRuntime =
  typeof process !== 'undefined' &&
  Boolean(process.versions?.node) &&
  !isBunRuntime &&
  !isDenoRuntime;
const isWindowsNodeRuntime = isNodeRuntime && process.platform === 'win32';
// Node on Windows does not execute the .cmd gh fixture through spawnSync.
// The injected-spawn tests below cover release result handling on that runner.
const canRunCliFixtures =
  !isDenoRuntime &&
  !isWindowsNodeRuntime &&
  typeof process !== 'undefined' &&
  process.execPath;

function prependPath(env, binPath) {
  const nextEnv = { ...env };
  const currentPath =
    Object.entries(nextEnv).find(
      ([key]) => key.toLowerCase() === 'path'
    )?.[1] ?? '';

  for (const key of Object.keys(nextEnv)) {
    if (key.toLowerCase() === 'path') {
      delete nextEnv[key];
    }
  }

  return {
    ...nextEnv,
    [process.platform === 'win32' ? 'Path' : 'PATH']:
      `${binPath}${path.delimiter}${currentPath}`,
  };
}

function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'create-release-'));
  const binPath = path.join(root, 'bin');

  mkdirSync(binPath, { recursive: true });
  writeFileSync(
    path.join(root, 'CHANGELOG.md'),
    `# Changelog

## 1.2.3

### Patch Changes

- Fix release creation

## 1.2.2

- Previous release
`
  );

  const fakeGhJs = path.join(binPath, 'fake-gh.js');
  writeFileSync(
    fakeGhJs,
    `#!/usr/bin/env node
const fs = require('node:fs');

const input = fs.readFileSync(0, 'utf8');

if (process.env.FAKE_GH_PAYLOAD_FILE) {
  fs.writeFileSync(process.env.FAKE_GH_PAYLOAD_FILE, input);
}

if (process.env.FAKE_GH_ARGS_FILE) {
  fs.writeFileSync(
    process.env.FAKE_GH_ARGS_FILE,
    JSON.stringify(process.argv.slice(2))
  );
}

if (process.env.FAKE_GH_MODE === 'success') {
  console.log(JSON.stringify({ id: 123 }));
  process.exit(0);
}

if (process.env.FAKE_GH_MODE === 'already_exists') {
  console.error('gh: Validation Failed (HTTP 422)');
  console.error('already_exists');
  process.exit(1);
}

console.error('gh: synthetic server error');
process.exit(1);
`
  );

  const fakeGhPath = path.join(binPath, 'gh');
  writeFileSync(
    fakeGhPath,
    `#!/bin/sh
exec "${process.execPath}" "$(dirname "$0")/fake-gh.js" "$@"
`
  );
  chmodSync(fakeGhPath, 0o755);

  writeFileSync(
    path.join(binPath, 'gh.cmd'),
    `@echo off\r\n"${process.execPath}" "%~dp0fake-gh.js" %*\r\n`
  );

  return root;
}

function runCreateRelease(root, mode, extraArgs = []) {
  const argsFile = path.join(root, 'gh-args.json');
  const payloadFile = path.join(root, 'gh-payload.json');
  const binPath = path.join(root, 'bin');
  const env = prependPath(
    {
      ...process.env,
      FAKE_GH_ARGS_FILE: argsFile,
      FAKE_GH_MODE: mode,
      FAKE_GH_PAYLOAD_FILE: payloadFile,
    },
    binPath
  );

  return {
    argsFile,
    payloadFile,
    result: spawnSync(
      process.execPath,
      [
        scriptPath,
        '--release-version',
        '1.2.3',
        '--repository',
        'owner/repo',
        ...extraArgs,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env,
      }
    ),
  };
}

function createSpawnRecorder(result) {
  const calls = [];

  return {
    calls,
    spawn(command, args, options) {
      calls.push({ args, command, options });
      return result;
    },
  };
}

describe('create-github-release release title formatting', () => {
  it('parses language from CLI arguments and environment defaults', () => {
    expect(parseArgs([], {})).toEqual({
      language: 'JavaScript',
      releaseVersion: '',
      repository: '',
      tagPrefix: 'v',
    });
    expect(parseArgs([], { LANGUAGE: 'TypeScript' })).toEqual({
      language: 'TypeScript',
      releaseVersion: '',
      repository: '',
      tagPrefix: 'v',
    });
    expect(parseArgs(['--language', 'JavaScript'], {})).toEqual({
      language: 'JavaScript',
      releaseVersion: '',
      repository: '',
      tagPrefix: 'v',
    });
    expect(parseArgs(['--language=Rust'], {})).toEqual({
      language: 'Rust',
      releaseVersion: '',
      repository: '',
      tagPrefix: 'v',
    });
  });

  it('builds a human-readable release name from a language-prefixed tag', () => {
    const changelog = `# Changelog

## 1.2.3

- Fix release creation
`;

    expect(
      JSON.parse(
        buildReleasePayload({
          changelog,
          language: 'JavaScript',
          tag: 'js-v1.2.3',
          version: '1.2.3',
        })
      )
    ).toEqual({
      tag_name: 'js-v1.2.3',
      name: '[JavaScript] 1.2.3',
      body: '- Fix release creation',
    });
  });
});

describe('create-github-release.mjs', () => {
  it('uses gh api and reports successful creation only for exit code 0', () => {
    const payload = JSON.stringify({ tag_name: 'v1.2.3' });
    const { calls, spawn } = createSpawnRecorder({
      status: 0,
      stderr: '',
      stdout: JSON.stringify({ id: 123 }),
    });

    expect(createRelease({ payload, repository: 'owner/repo', spawn })).toEqual(
      {
        alreadyExists: false,
      }
    );
    expect(calls).toEqual([
      {
        args: [
          'api',
          'repos/owner/repo/releases',
          '-X',
          'POST',
          '--input',
          '-',
        ],
        command: 'gh',
        options: {
          encoding: 'utf8',
          input: payload,
        },
      },
    ]);
  });

  it('throws when gh api exits non-zero with an unexpected error', () => {
    const { spawn } = createSpawnRecorder({
      status: 1,
      stderr: 'gh: synthetic server error',
      stdout: '',
    });
    let thrownError;

    try {
      createRelease({
        payload: '{}',
        repository: 'owner/repo',
        spawn,
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError.message).toContain('gh api failed with code 1');
    expect(thrownError.message).toContain('synthetic server error');
  });

  it('treats already_exists as an idempotent gh api result', () => {
    const { spawn } = createSpawnRecorder({
      status: 1,
      stderr: 'already_exists',
      stdout: '',
    });

    expect(
      createRelease({
        payload: '{}',
        repository: 'owner/repo',
        spawn,
      })
    ).toEqual({ alreadyExists: true });
  });

  if (canRunCliFixtures) {
    it('passes release payload to gh api and reports success only on exit code 0', () => {
      const root = createFixture();

      try {
        const { argsFile, payloadFile, result } = runCreateRelease(
          root,
          'success'
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Creating GitHub release for v1.2.3');
        expect(result.stdout).toContain('Created GitHub release: v1.2.3');
        expect(JSON.parse(readFileSync(argsFile, 'utf8'))).toEqual([
          'api',
          'repos/owner/repo/releases',
          '-X',
          'POST',
          '--input',
          '-',
        ]);
        expect(JSON.parse(readFileSync(payloadFile, 'utf8'))).toEqual({
          tag_name: 'v1.2.3',
          name: '[JavaScript] 1.2.3',
          body: '### Patch Changes\n\n- Fix release creation',
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('passes a human-readable release name for language-prefixed tags', () => {
      const root = createFixture();

      try {
        const { payloadFile, result } = runCreateRelease(root, 'success', [
          '--tag-prefix',
          'js-v',
          '--language',
          'JavaScript',
        ]);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain(
          'Creating GitHub release for js-v1.2.3'
        );
        expect(JSON.parse(readFileSync(payloadFile, 'utf8'))).toEqual({
          tag_name: 'js-v1.2.3',
          name: '[JavaScript] 1.2.3',
          body: '### Patch Changes\n\n- Fix release creation',
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('fails when gh api exits non-zero with an unexpected error', () => {
      const root = createFixture();

      try {
        const { result } = runCreateRelease(root, 'failure');

        expect(result.status).toBe(1);
        expect(result.stdout).toContain('Creating GitHub release for v1.2.3');
        expect(result.stdout).not.toContain('Created GitHub release');
        expect(result.stderr).toContain('gh api failed with code 1');
        expect(result.stderr).toContain('synthetic server error');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('treats already_exists as an explicit idempotent skip', () => {
      const root = createFixture();

      try {
        const { result } = runCreateRelease(root, 'already_exists');

        expect(result.status).toBe(0);
        expect(result.stdout).toContain(
          'GitHub release already exists: v1.2.3. Skipping creation.'
        );
        expect(result.stdout).not.toContain('Created GitHub release');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
