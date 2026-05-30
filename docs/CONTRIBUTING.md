# Contributing to LinksQL

LinksQL ships a single specification ([`docs/SPECIFICATION.md`](SPECIFICATION.md))
and four reference implementations that must stay behaviourally identical:

| Language   | Directory | Toolchain                              |
| ---------- | --------- | -------------------------------------- |
| JavaScript | `js/`     | Node.js / Bun / Deno, `test-anywhere`  |
| Rust       | `rust/`   | `cargo test`, `clippy`, `rustfmt`      |
| Python     | `python/` | `pytest`, `ruff`, `mypy`               |
| C#         | `csharp/` | `dotnet test` (xUnit), `dotnet format` |

When you change query semantics, update the specification first, then mirror the
change in every implementation and its tests so the four stay in lock-step.

## Development Workflow

1. **Fork the repository** and clone your fork
2. **Create a feature branch**: `git checkout -b feature/my-feature`
3. **Install dependencies**: `cd js && bun install` (or `npm install`) — the
   JavaScript package and its tooling live in `js/`
4. **Make your changes**
5. **Run local checks**: `bun run check` (from `js/`)
6. **Bump the version** of any package you changed (see
   [Versioning and releases](#versioning-and-releases))
7. **Commit and push** (pre-commit hooks will run automatically)
8. **Create a Pull Request**

## Code Standards

### File Size Limits

**Maximum 1500 lines per file** (enforced via ESLint `max-lines` rule and CI `check-file-line-limits` job).

This benefits both AI and human developers by ensuring files remain readable and maintainable.

### Formatting and Linting

All code must pass (run these from `js/`):

```bash
# Check formatting
bun run format:check

# Check linting
bun run lint

# Run all checks
bun run check
```

The pre-commit hook runs automatically, but you can also manually format and fix:

```bash
# Auto-fix formatting
bun run format

# Auto-fix lint issues
bun run lint:fix
```

### Testing Requirements

Tests should:

- Cover critical paths
- Work across all runtimes (Node.js, Bun, Deno)
- Use the [test-anywhere](https://github.com/link-foundation/test-anywhere) framework

```bash
# JavaScript — run tests on any runtime (from js/)
cd js
bun test --timeout 30000
npm test
deno test --allow-read
```

For the other implementations, run the native test commands inside each
directory:

```bash
# Rust
cd rust && cargo test

# Python
cd python && python -m pytest

# C#
cd csharp && dotnet test
```

## Versioning and releases

Each implementation is released independently from its own manifest. There is no
shared version and no changeset tooling — when you change a package in a way that
affects users, bump that package's version in the same PR.

| Language   | Version lives in                  | Published to | Release tag        |
| ---------- | --------------------------------- | ------------ | ------------------ |
| JavaScript | `js/package.json`                 | npm          | `js_<version>`     |
| Rust       | `rust/Cargo.toml`                 | crates.io    | `rust_<version>`   |
| Python     | `python/pyproject.toml`           | PyPI         | `python_<version>` |
| C#         | `csharp/src/LinksQL/LinksQL.csproj`| NuGet       | `csharp_<version>` |

Use [semantic versioning](https://semver.org/):

| Bump      | When to Use                          | Examples                                            |
| --------- | ------------------------------------ | --------------------------------------------------- |
| **Patch** | Bug fixes, internal changes          | Fix typo, update dependency, refactor internal code |
| **Minor** | New features, non-breaking additions | Add new function, new optional parameter            |
| **Major** | Breaking changes                     | Remove function, change API signature               |

A version bump is **required** for bug fixes, new features, breaking changes and
public API changes. It is **not** required for documentation-only changes, other
markdown edits, or CI/CD workflow updates that do not affect users.

### Release Process

The release process is fully automated per language. On push to `main`, each
per-language workflow (`js.yml`, `rust.yml`, `python.yml`, `csharp.yml`) only
runs when files in its directory changed, then:

1. **Lint, format and test** the changed implementation
2. **Compare the manifest version** against the published registry
3. **Publish** to the registry only if that version is not already published
4. **Create a GitHub release** tagged with the language-prefixed version

Because publishing is idempotent (it is skipped when the version already exists),
merging a PR without a version bump simply ships nothing — no manual coordination
is needed when several PRs land before a release.

## Pull Request Guidelines

### PR Title

Use a clear, descriptive title that summarizes the change:

```
feat: Add support for custom configuration
fix: Resolve race condition in async handler
docs: Update API documentation for v2
```

### PR Description

Include:

- **What** - Describe the change
- **Why** - Explain the motivation
- **Testing** - How the change was tested

### CI Checks

All PRs must pass the checks for every implementation they touch:

- [ ] Lint, format and duplication checks (`npm run check`, `cargo fmt`/`clippy`, `ruff`/`mypy`, `dotnet format`)
- [ ] File line limits check (JavaScript)
- [ ] Tests on all platforms (Ubuntu, macOS, Windows) and runtimes (Node.js, Bun, Deno) for JavaScript
- [ ] `cargo test`, `pytest` and `dotnet test` for the Rust, Python and C# ports

### Fresh Merge Simulation

The CI workflow automatically:

1. Merges the latest `main` into your PR branch
2. Runs checks against the merged state

If this fails with merge conflicts, you need to:

```bash
git fetch origin main
git merge origin/main
# Resolve conflicts
git push
```

## Questions?

If you have questions about contributing, feel free to open an issue for discussion.
