# Best Practices for AI-Driven Development

This document describes CI/CD best practices that significantly improve the quality and reliability of AI-driven development workflows. When properly configured, AI solvers are forced to iterate with CI/CD checks until all tests pass, ensuring code quality meets the highest standards.

## Why CI/CD Matters for AI Development

AI-driven development creates a powerful feedback loop:

1. **AI creates a solution** - The solver generates code based on issue requirements
2. **CI/CD validates the solution** - Automated checks verify code quality
3. **AI iterates until passing** - The solver fixes issues until all checks pass
4. **Quality is guaranteed** - No code merges without passing all gates

This approach ensures consistent quality regardless of whether the team consists of humans, AIs, or both.

## This Template's Best Practices

This template implements the following best practices from the [hive-mind](https://github.com/link-assistant/hive-mind) project:

### 1. File Size Limits

**Maximum of 1500 lines per code file** (enforced via ESLint `max-lines` rule).

This constraint benefits both AI and human developers:

- AI models can read and understand entire files within context windows
- Humans can navigate and comprehend files without cognitive overload
- Forces modular, well-organized code architecture

### 2. Automated Code Formatting

Consistent formatting eliminates style debates and reduces diff noise:

| Tool     | Purpose                      |
| -------- | ---------------------------- |
| ESLint   | Code quality and style rules |
| Prettier | Code formatting              |
| Husky    | Pre-commit hooks             |

### 3. Static Analysis & Linting

Catch bugs and enforce patterns before code reaches review:

- ESLint with strict rules
- Strict unused variables rule (no `_` prefix exceptions)
- Async/await best practices enforcement

### 4. Comprehensive Testing

Tests run across multiple dimensions:

- **Cross-runtime**: Node.js, Bun, and Deno
- **Cross-platform**: Ubuntu, macOS, and Windows
- **Test framework**: [test-anywhere](https://github.com/link-foundation/test-anywhere) for universal compatibility

### 5. Per-Language Version-Bump Releasing

Each implementation is released independently from its own manifest
(`js/package.json`, `rust/Cargo.toml`, `python/pyproject.toml`,
`csharp/src/LinksQL/LinksQL.csproj`):

- **Independent versions** - A change to one language never forces a release of another
- **Idempotent publishing** - Each workflow publishes only when its manifest version is not already on the registry, so PRs without a bump simply ship nothing
- **Explicit semantic versioning** - Contributors choose patch/minor/major by editing the manifest version directly
- **No shared tooling** - There is no changeset step to keep in sync across the four implementations

### 6. Pre-commit Hooks

Local quality gates prevent broken commits from reaching CI:

1. Format check and auto-fix
2. Lint and static analysis
3. File size validation

### 7. Release Automation

Automated release workflows ensure:

- **One workflow per language** - `js.yml`, `rust.yml`, `python.yml` and `csharp.yml` each release their own package
- **Path-filtered triggers** - A workflow only runs when files in its directory change, saving CI minutes
- **Validated releases only** - Lint, format and the full test matrix must pass before publishing
- **Idempotent publishing** - Each workflow checks the registry first and skips publishing a version that already exists
- **Language-prefixed GitHub releases** - Tags such as `js_<version>` and `rust_<version>` keep the four release streams distinct

### 8. CI/CD Pipeline Features

The workflow implements several critical features from hive-mind issues #1274 and #1278, plus template reliability fixes:

#### Concurrency Control

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}
```

This configuration (applied in `example-app.yml`) ensures:

- **Main branch**: Runs finish without newer pushes cancelling in-flight release work
- **PR branches**: Newer pushes cancel stale runs to save CI minutes and avoid racing checks

See [DETAILED-COMPARISON.md](./case-studies/issue-25/DETAILED-COMPARISON.md) for the full analysis of best practices from both repositories.

#### Fresh Merge Testing

The per-language workflows trigger on the standard `pull_request` event, which
GitHub Actions evaluates against the **merge commit** of the PR branch with the
latest base branch — not the PR branch in isolation. This prevents "stale merge
preview" issues where checks pass on outdated code, without any custom merge
script.

### 9. Fast-Fail Job Ordering

**Run fast checks before slow checks** to give the fastest possible feedback:

```
Fast checks (~7-30s each):     Slow checks (~1-20 min each):
├── lint (ESLint)              └── test matrix (3 runtimes x 3 OS for JS;
├── format (Prettier)              Python/Rust/C# versions for the ports)
├── duplication (jscpd)
└── check-file-line-limits
```

Each language workflow gates its `test` job on the `check`/`lint` job, so the
slow test matrix only runs after the fast checks pass. This dramatically reduces
feedback time for AI solvers — a lint or formatting error is caught in seconds
instead of waiting for the full test matrix.

### 10. File Line Limits in CI

In addition to the ESLint `max-lines` rule (which only covers the source files it lints), a separate CI check enforces the 1500-line limit on:

- All JavaScript files (`.js`, `.mjs`, `.cjs`, including scripts)
- All Markdown files (`.md`, including documentation)

This is enforced by `js/scripts/check-file-line-limits.sh` (run via `npm run check` in the `js` workflow). Case-study and generated-data files under `docs/case-studies/*/data/` are exempt because they mirror external sources verbatim (the same paths are ignored by ESLint).

### 11. Secrets Detection

Scanning for accidental credential leaks using [secretlint](https://github.com/secretlint/secretlint):

- The recommended rule set is provided via `.secretlintrc.json`
- Run on demand with `npx secretlint "**/*"` to catch API tokens, passwords, and private keys before committing

### 12. Documentation Validation

Documentation is validated in CI just like code:

- **Line limits**: the 1500-line cap covers Markdown as well as JavaScript (`js/scripts/check-file-line-limits.sh`, run by the `js` workflow's `check` job)
- **Broken links**: `links.yml` checks every link in Markdown/HTML on any doc change (case studies excluded)

### 13. Reasonable Timeouts on Every Job and Test

Every CI job declares an explicit `timeout-minutes`, sized at roughly
5-10x the typical run time for that job. This keeps feedback fast when
a test, network call, package install, or release step hangs:

- Fast checks fail within 5-10 minutes instead of waiting for GitHub
  Actions' six-hour default.
- Matrix test jobs have a 10-minute cap per runtime and operating
  system.
- Release jobs have 30 minutes for package registry and GitHub API
  retries without allowing an unbounded release run.
- The broken link checker has 10 minutes for slow external hosts and
  Web Archive fallback probes.

Current timeout bands (per-language workflows share the same shape):

| Job                                | Cap          |
| ---------------------------------- | ------------ |
| `findChanged<Lang>Files`           | 10 min       |
| `check` / `lint`                   | 10 min       |
| `test` per runtime/OS/version      | 15 min (Rust 20) |
| `publishTo<Registry>`              | 15 min (Rust 20) |
| `publishRelease`                   | 10 min       |
| `links.yml` link checker           | 10 min       |
| `example-app.yml` build/package    | 10–30 min    |

Per-test timeouts are also enforced inside the runners that support a
global budget:

```bash
node --test --test-timeout=30000
bun test --timeout 30000
```

The Node command is invoked with no path argument so the built-in test
runner uses its default recursive discovery (matching `tests/*.test.js`
while excluding `node_modules`). This stays correct across Node 20, 22 and
24 and on every OS — unlike a `tests/*.test.js` glob (PowerShell does not
expand it on Windows) or a bare `tests/` directory argument (Node 22+ no
longer scans a positional directory and tries to load it as a module).

Deno does not currently provide an equivalent single global per-test
timeout flag, so Deno tests are protected by the 10-minute matrix job
timeout.

### 14. Proper Cancellation Propagation

Use `!cancelled()` instead of `always()` in job conditions (hive-mind issue #1278):

```yaml
# Bad - always() prevents cancellation from propagating
if: always() && needs.lint.result == 'success'

# Good - !cancelled() allows cancellation to propagate
if: !cancelled() && needs.lint.result == 'success'
```

When a workflow run is cancelled, `always()` still evaluates to `true`, causing dependent jobs to run unnecessarily. `!cancelled()` properly stops the chain.

## Quality Enforcement Strategy

The template implements a defense-in-depth approach:

```
Developer Machine    ->    CI/CD Pipeline               ->    Release
├── Pre-commit hooks      ├── Fast checks (~7-30s)           ├── All checks pass
├── Local tests           │   ├── lint + format + dedup      ├── Manifest version is new
└── IDE integration       │   └── file line limits           └── Publish to registry
                          ├── Slow checks (~1-20 min)            + GitHub release
                          │   └── test matrix (per language)
                          └── Broken-link check (Markdown/HTML)
```

Each layer catches different issues, ensuring no problematic code reaches production.

## References

- [Code Architecture Principles](https://github.com/link-foundation/code-architecture-principles)
- [hive-mind CI/CD Best Practices](https://github.com/link-assistant/hive-mind/blob/main/docs/CI-CD-BEST-PRACTICES.md)
- [hive-mind CI/CD Case Studies](https://github.com/link-assistant/hive-mind/tree/main/docs/case-studies)
- [Issue #1274 Analysis](./case-studies/issue-25/data/issue-1274-case-study.md) - Concurrency blocking
- [Issue #1278 Analysis](./case-studies/issue-25/data/issue-1278-case-study.md) - always() cancellation prevention
- [Issue #29 Analysis](./case-studies/issue-29/README.md) - CI/CD best practices alignment
