# Changelog

## 0.11.3

### Patch Changes

- a8e4030: Run the preview screenshot regeneration workflow inside the official Playwright container to avoid stalled Chromium downloads in CI, and keep the desktop packaging job on Node 20 while verifying package output before artifact upload.

## 0.11.2

### Patch Changes

- aeec4cb: Enforce the 1500-line architecture limit across all JavaScript (`.js`, `.mjs`, `.cjs`) and Markdown (`.md`) files in the `check-file-line-limits` CI gate, lower the documentation limit from 2500 to 1500, and exempt case-study generated-data files explicitly.

## 0.11.1

### Patch Changes

- 8cd0d70: Correct CI workflow concurrency and preview failure artifact handling in the template.

## 0.11.0

### Minor Changes

- e7025ed: Add a release-time `preview-regen` job to `example-app.yml` and a
  `scripts/update-preview-images.mjs` driver that boot the universal example app
  in a headless Chromium via `browser-commander` + Playwright, capture a
  locale × theme matrix of screenshots into `docs/screenshots/example-app/`, and
  commit any drift back to `main` with `[skip ci]`. Adds the matching
  `npm run example:web:preview-images` script.

## 0.10.2

### Patch Changes

- f044604: Document the one-time **Settings → Pages → Source = GitHub Actions** prerequisite for the example app deployment, and note it in a comment above the `pages-deploy` job.

## 0.10.1

### Patch Changes

- ede9f84: Publish the template as the real link-foundation example package and add the globally installable CLI entry point.

## 0.10.0

### Minor Changes

- 5a81a7f: Add a universal React example app with GitHub Pages, Electron desktop, and Capacitor mobile build paths.

## 0.9.0

### Minor Changes

- f23283c: Add an optional Docker Hub publishing path that waits for the exact npm
  package version before tagging Docker images.

## 0.8.6

### Patch Changes

- acccf75: Format GitHub release names as human-readable `[Language] x.y.z` titles while keeping prefixed tag names unchanged.

## 0.8.5

### Patch Changes

- Fail GitHub release creation on unexpected gh api errors and clearly skip releases that already exist.

  Enforce npm and Node.js minimum versions for trusted publishing setup and resolve a supported npm 11 tarball for fallback installs.

## 0.8.4

### Patch Changes

- 031f7cd: Add explicit CI job timeouts and per-test runner timeout limits.

## 0.8.3

### Patch Changes

- bdaa4b7: Derive release script package names from package.json instead of template placeholders.

## 0.8.2

### Patch Changes

- d179bb7: Add warning annotations for files approaching the CI file line limit.

## 0.8.1

### Patch Changes

- f0c69af: Normalize language-prefixed release tags before building npm shields.io badge URLs.

## 0.8.0

### Minor Changes

- 3e45a9c: Add `--tag-prefix` option to release scripts for multi-language repos

  The `create-github-release.mjs` and `format-github-release.mjs` scripts now accept a `--tag-prefix` CLI parameter (defaulting to `v`) that allows users to customize the git tag prefix. This enables use in multi-language repositories where different language packages need distinct tag prefixes (e.g., `js-v1.0.0` vs `rust-v1.0.0`).

## 0.7.3

### Patch Changes

- ae2cc9a: Add self-healing release mechanism that checks npm registry for unpublished versions

## 0.7.2

### Patch Changes

- 9126e16: fix: npm upgrade fallbacks and Node.js 24.x upgrade for CI/CD
  - Upgrade Node.js from 20.x to 24.x in all workflow files (avoids broken npm in Node.js 22.22.2)
  - Add 4-strategy fallback chain to setup-npm.mjs (standard, curl tarball, npx, corepack)
  - Update GitHub Actions to latest versions (checkout v6, setup-node v6, create-pull-request v8)
  - Add case study documentation for issue #33

## 0.7.1

### Patch Changes

- 6916409: Use per-commit diff instead of full-PR diff for CI change detection

## 0.7.0

### Minor Changes

- 983789a: Add CI/CD best practices from hive-mind: fast-fail job ordering, test compilation, file line limits check, secrets detection, documentation validation, extracted fresh merge simulation script, and proper cancellation propagation

## 0.6.0

### Minor Changes

- 8961862: Add automated broken link checker with Web Archive fallback suggestions
  - Add `.github/workflows/links.yml` with lychee-action for link checking in Markdown and HTML files
  - Add `scripts/check-web-archive.mjs` to check broken links against the Wayback Machine API
  - Add `.lycheeignore` for excluding known false-positive URLs (localhost, example.com, etc.)
  - Update `README.md` to document the broken link checker feature
  - Scheduled weekly check (Mondays at 09:00 UTC) to catch links that break over time
  - On PRs, broken links with no Web Archive fallback will fail the check
  - For broken links that have archived versions, provides actionable replacement suggestions
  - On scheduled runs, automatically creates a GitHub Issue with the full broken links report

  Fixes #27

## 0.5.1

### Patch Changes

- e398190: Add comprehensive best practices comparison and improve CI concurrency
  - Add DETAILED-COMPARISON.md with side-by-side analysis of ALL scripts, workflows, and configurations
  - Implement cancel-in-progress for main branch concurrency (hive-mind Issue #1274 fix)
  - Fix max-lines documentation (1500, not 1000)
  - Reference detailed comparison from BEST-PRACTICES.md

## 0.5.0

### Minor Changes

- 66211b5: Add fresh merge simulation to CI/CD to prevent stale merge preview issues
  - Add "Simulate fresh merge with base branch" step to lint and test jobs
  - This ensures PR CI validates the actual merge result, not a stale snapshot
  - Prevents CI failures on main branch after merging PRs that sat open for days
  - Add case study documentation for issue #23 with root cause analysis
  - Add ignore patterns for case study data files in ESLint and Prettier

  See docs/case-studies/issue-23 for detailed analysis of the stale merge preview problem.

  Fixes #23

## 0.4.0

### Minor Changes

- e6c2691: Add multi-language repository support for CI/CD scripts
  - Add `scripts/js-paths.mjs` utility for automatic JavaScript package root detection
  - Support both `./package.json` (single-language) and `./js/package.json` (multi-language repos)
  - Add `--legacy-peer-deps` flag to npm install commands in release scripts to fix ERESOLVE errors
  - Save and restore working directory after `cd` commands to fix `command-stream` library's `process.chdir()` behavior
  - Add case study documentation with root cause analysis in `docs/case-studies/issue-21/`

## 0.3.0

### Minor Changes

- 80d9c84: Add CI check to prevent manual version modification in package.json
  - Added `check-version.mjs` script that detects manual version changes in PRs
  - Added `check-changesets.mjs` script to check for pending changesets (converted from inline shell)
  - Added `version-check` job to release.yml workflow
  - Automated release PRs (changeset-release/_ and changeset-manual-release-_) are automatically skipped

## 0.2.2

### Patch Changes

- 9a12139: Fix CI/CD check differences between pull request and push events

  Changes:
  - Add `detect-changes` job with cross-platform `detect-code-changes.mjs` script
  - Make lint job independent of changeset-check (runs based on file changes only)
  - Allow docs-only PRs without changeset requirement
  - Handle changeset-check 'skipped' state in dependent jobs
  - Exclude `.changeset/`, `docs/`, `experiments/`, `examples/` folders and markdown files from code changes detection

## 0.2.1

### Patch Changes

- 55aef41: Make Bun the primary runtime choice throughout the template
  - Update all shebangs from `#!/usr/bin/env node` to `#!/usr/bin/env bun` in scripts, experiments, and case studies
  - Update README.md to prioritize Bun in all sections (features, development, runtime support, package managers, scripts reference)
  - Update examples to list Bun first
  - Bun now described as "Primary runtime with highest performance" and "Primary choice" for package management
  - Maintains full compatibility with Node.js and Deno

## 0.2.0

### Minor Changes

- d3f7fcd: Improve changeset CI/CD robustness for concurrent PRs
  - Update validate-changeset.mjs to only check changesets ADDED by the current PR (not pre-existing ones)
  - Add merge-changesets.mjs script to combine multiple pending changesets during release
  - Merged changesets use highest version bump type (major > minor > patch) and combine descriptions chronologically
  - Update release workflow to pass SHA environment variables and add merge step
  - Add comprehensive case study documentation for the CI/CD improvement
  - This prevents PR failures when multiple PRs merge before a release cycle completes

## 0.1.4

### Patch Changes

- e9703b9: Add ESLint complexity rules with reasonable thresholds

## 0.1.3

### Patch Changes

- 0198aaa: Add case study documentation comparing best practices from effect-template

  This changeset adds comprehensive documentation analyzing best practices from
  ProverCoderAI/effect-template repository, identifying gaps in our current setup,
  and providing prioritized recommendations for improvements.

  Key findings include missing best practices like code duplication detection (jscpd),
  ESLint complexity rules, VS Code settings, and test coverage thresholds.

## 0.1.2

### Patch Changes

- 2ea9b78: Enforce strict no-unused-vars ESLint rule without exceptions. All unused variables, arguments, and caught errors must now be removed or used. The `_` prefix no longer suppresses unused variable warnings.

## 0.1.1

### Patch Changes

- 042e877: Fix GitHub release formatting to support Major/Minor/Patch changes

  The release formatting script now correctly handles all changeset types (Major, Minor, Patch) instead of only Patch changes. This ensures that:
  - Section headers are removed from release notes
  - PR detection works for all release types
  - NPM badges are added correctly

## 0.1.0

### Minor Changes

- 65d76dc: Initial template setup with complete AI-driven development pipeline

  Features:
  - Multi-runtime support for Node.js, Bun, and Deno
  - Universal testing with test-anywhere framework
  - Automated release workflow with changesets
  - GitHub Actions CI/CD pipeline with 9 test combinations
  - Code quality tools: ESLint + Prettier with Husky pre-commit hooks
  - Package manager agnostic design

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
