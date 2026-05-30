# LinksQL (C#)

A faithful C# (.NET 8) port of the [LinksQL](../) core engine. The JavaScript
implementation under [`../src`](../src) is the ground truth; this port reproduces
its observable behaviour exactly, with the same parser, store, name registry,
substitution engine and query semantics.

LinksQL is an associative engine built on a single primitive — the **link**
(doublet) `(index: source target)` — and a single operation: **substitution**.
The four CRUD behaviours all fall out of how a query's restriction and
substitution pattern lists line up positionally. Surface syntax is
[LiNo (Links Notation)](../docs/SPECIFICATION.md).

## Layout

| Path | Contents |
| --- | --- |
| `src/LinksQL/Lino.cs` | LiNo AST, tokenizer, recursive-descent parser, serializer |
| `src/LinksQL/Store.cs` | `LinksStore` + `Link`: in-memory doublets store with dedup and identity allocation |
| `src/LinksQL/Names.cs` | `Names`: bidirectional label ↔ index registry (points) |
| `src/LinksQL/Substitution.cs` | The substitution engine: matching, join, materialisation, `Execute` |
| `src/LinksQL/Query.cs` | `Database` + query split/classify/serialise helpers |
| `src/LinksQL/Errors.cs` | The exception hierarchy (names mirror the JS reference) |
| `tests/LinksQL.Tests/` | xUnit tests porting `tests/lino.test.js` and `tests/engine.test.js` 1:1 |

## Build and test

```sh
dotnet restore
dotnet build -c Release
dotnet test -c Release
```

The build is strict: `TreatWarningsAsErrors`, `AnalysisLevel=latest-all`,
`WarningLevel=9999`, code-style enforcement and XML documentation are all on.

## Specification

See [`../docs/SPECIFICATION.md`](../docs/SPECIFICATION.md) for the full model
and semantics.
