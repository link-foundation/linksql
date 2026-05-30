---
'@link-foundation/linksql': minor
---

Establish LinksQL — a standard and reference implementation of an associative
query language built on a single data primitive (the link/doublet) and a single
operation (substitution), in the style of link-cli.

- **Specification.** `docs/SPECIFICATION.md` defines the normative model: the
  Links Notation (LiNo) surface syntax, the doublets store, named references,
  the single substitution operation, and how read/create/update/delete fall
  out of positional restriction↔substitution pairing.
- **JavaScript reference implementation.** LiNo parser, links store,
  substitution engine, query executor, triggers/subscriptions, HTTP server and
  client, public API and CLI — zero runtime dependencies.
- **Polyglot reference implementations.** Behaviourally-identical Rust, Python
  and C# ports under `rust/`, `python/` and `csharp/`, each validated against
  the same spec by its native toolchain.
- **CI/CD.** The release pipeline now lints and tests every language (rustfmt +
  clippy, ruff + mypy + pytest, dotnet format + build + test) across the
  supported operating systems, and gates releases on a green signal from all of
  them.
