# linksql (Rust)

A Rust reference implementation of **LinksQL** — an associative query language
built on a single data primitive (the *link*, a doublet) and a single operation
(*substitution*). It is a faithful, behaviourally-identical port of the
JavaScript reference implementation in [`../src`](../src), validated against the
same behaviour.

Everything is a link: a triple `(index: source target)` of positive integers. A
link whose source and target equal its own index is a *point*. Read, create,
update, and delete are not separate primitives — they are derived from how a
query's *restriction* and *substitution* pattern lists line up positionally:

```text
create   ()        ((s t))     empty restriction, one created link
read     ((p))                  restriction only, no mutation
update   ((a b))   ((a c))      matched link rewritten in place
delete   ((a b))   ()           matched link with no replacement is removed
```

## Usage

```rust
use linksql::Database;

let mut db = Database::new(true); // auto-create named references
let report = db.query("() ((alice bob))")?; // alice -> bob
assert_eq!(report.operation.as_str(), "create");
assert_eq!(db.count(), 3); // alice point, bob point, the link
# Ok::<(), linksql::Error>(())
```

## Build and test

This crate is **zero-dependency** (std only).

```sh
cargo test                              # run the test suite
cargo fmt --all -- --check              # formatting check
cargo clippy --all-targets --all-features
cargo test --doc                        # doctest the examples
```

## Specification

The normative specification is [`../docs/SPECIFICATION.md`](../docs/SPECIFICATION.md).
Where this implementation and the specification disagree, the specification is
normative and the implementation is a bug.
