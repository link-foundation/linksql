# LinksQL Specification

**Version:** 0.1 (draft) · **Status:** reference

LinksQL is an associative query language built on **one data primitive** (the
link, a doublet) and **one operation** (substitution). This document defines the
language precisely enough that independent implementations — the JavaScript,
Rust, Python, and C# reference implementations in this repository — behave
identically. Where this document and an implementation disagree, this document
is normative and the implementation is a bug.

The design goals, restated from the project's motivation:

- Provide GraphQL-class power — queries, mutations, subscriptions, schema
  introspection — while being **simpler, more universal, and more adaptive**, in
  the style of [link-cli](https://github.com/link-foundation/link-cli).
- Express read, create, update, and delete through a **single substitution
  operation** rather than separate primitives.
- Be powerful enough to replace GraphQL across
  [deep-foundation](https://github.com/deep-foundation).

Throughout, the key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are
used in the sense of RFC 2119.

---

## 1. Data model

### 1.1 Links and doublets

The model contains exactly one kind of entity: the **link** (also called a
_doublet_). A link is a triple of positive integers:

```
(index: source target)
```

- **`index`** — the link's unique identity. Every link has exactly one index,
  and no two links share an index.
- **`source`** — the index of the link this link points _from_.
- **`target`** — the index of the link this link points _to_.

`source` and `target` MUST refer to link indices. There is no separate notion of
a scalar, string, or node: a value is always another link, and the graph is
closed under reference.

### 1.2 Points

A link whose `source` and `target` both equal its own `index` is a **point**:

```
(i: i i)
```

A point is the atom of the model — a link that refers only to itself. Named
references (§5) are materialised as points.

### 1.3 Integrity invariants

An implementation MUST enforce the following invariants on its store:

1. **Positive integer identities.** `index`, `source`, and `target` are integers
   `≥ 1`.
2. **Unique identity.** At most one link exists for any given `index`.
3. **Structural deduplication.** At most one link exists for any given
   `(source, target)` pair. Creating a link whose `(source, target)` already
   exists MUST return the existing link rather than creating a duplicate.

Invariant 3 is what makes the store associative: the structure `(source,
target)` is itself an address.

### 1.4 Identity allocation

Implementations allocate identities from a monotonic counter:

- The allocator starts at `1`.
- Allocating an identity returns the smallest unused index at or above the
  counter, then advances the counter past it.
- When a link is created or updated with an explicit `index`, the allocator is
  advanced so that it never later hands out that index (`reserveIndex`: if the
  explicit index is `≥` the counter, the counter becomes `index + 1`).

Explicit indices MUST be positive integers and MUST NOT already be in use;
violating either is an integrity error.

### 1.5 Store operations

The store is a pure data container exposing this surface. Pattern matching and
substitution (§4) build on it but live above it.

| Operation                                    | Behaviour                                                                                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create({index?, source, target})`           | If `(source, target)` exists, return it (and error if a conflicting explicit `index` was given). Otherwise allocate or use the explicit `index` and insert a new link. |
| `update(index, {source, target, newIndex?})` | Replace the structure of an existing link, keeping its identity unless `newIndex` is given. Error if the new `(source, target)` collides with a _different_ link.      |
| `delete(index)`                              | Remove the link with this identity. Returns whether a link was removed.                                                                                                |
| `findByPair(source, target)`                 | Return the link with this structure, or nothing.                                                                                                                       |
| `get(index)` / `has(index)`                  | Fetch / test a link by identity.                                                                                                                                       |
| `all()` / `size`                             | Enumerate all links / count them.                                                                                                                                      |
| `clear()`                                    | Remove every link and reset the allocator to `1`.                                                                                                                      |

Errors raised by the store are integrity errors (the JavaScript reference calls
this `LinkIntegrityError`).

---

## 2. Links Notation (LiNo)

LiNo is the textual surface syntax for the model and for queries. It is parsed
into an explicit AST so the rest of the engine never re-tokenizes text.

### 2.1 Grammar

```ebnf
document  = { value } ;
value     = link | reference ;
link      = "(" [ value ":" ] { value } ")" ;
reference = number | name | variable | wildcard | string ;
number    = digit , { digit } ;
variable  = "$" , name ;
wildcard  = "*" ;
name      = bareword | string ;
```

### 2.2 Tokenization

The tokenizer recognises the structural characters `(`, `)`, and `:`, quoted
strings, and barewords (maximal runs of non-whitespace, non-delimiter
characters).

- **Whitespace** (token separators, otherwise insignificant): space, tab,
  newline, carriage return, form feed, vertical tab.
- **Delimiters**: `(`, `)`, `:`, `"`, `'`.
- **Strings**: opened by `"` or `'` and closed by the matching quote. A backslash
  escapes the next character. An unterminated string is a syntax error. A quoted
  token is always a **name**, even if its content looks like a number.
- **Barewords** are classified:
  - exactly `*` → **wildcard**
  - starting with `$` → **variable** whose name is the text after `$`
  - matching `^[0-9]+$` → **number** (parsed as an integer)
  - otherwise → **name**

### 2.3 Abstract syntax

Parsing produces two node shapes:

- **Reference node**: `{ type: "ref", kind, value }` where `kind` is one of
  `number`, `name`, `variable`, `wildcard`. For `number`, `value` is an integer;
  otherwise `value` is the string label / variable name / `"*"`.
- **Link node**: `{ type: "link", id, values }` where `id` is a reference node, a
  nested link node, or `null` (absent), and `values` is an ordered list of nodes.

The link form `( [ id ":" ] values… )` maps to AST as follows:

| Source       | `id`   | `values`    |
| ------------ | ------ | ----------- |
| `()`         | `null` | `[]`        |
| `(a)`        | `null` | `[a]`       |
| `(a: b c)`   | `a`    | `[b, c]`    |
| `(a b)`      | `null` | `[a, b]`    |
| `(a: b c d)` | `a`    | `[b, c, d]` |

A `document` is an ordered list of top-level values.

### 2.4 Serialization

Serialization is the inverse and produces canonical text:

- variable → `$name`; wildcard → `*`; number → its decimal digits.
- A name is emitted bare unless it is empty or contains whitespace, `(`, `)`,
  `:`, `"`, or `'`, in which case it is double-quoted with `\` and `"` escaped.
- A link with an `id` serialises as `(id: v1 v2 …)`, or `(id:)` when it has no
  values; a link without an `id` serialises as `(v1 v2 …)`.

A stored link `{index, source, target}` has the canonical form
`(index: source target)`, e.g. `(3: 1 2)`.

---

## 3. Queries

A **query** is a LiNo document of one or two top-level link nodes:

```
(restriction)                  # one node  → read
(restriction) (substitution)   # two nodes → substitution
```

Each top-level node MUST be a link node with **no `id`** (a parenthesised list).
Its `values` are the **patterns**. Thus `((a b)) ((a c))` is a query whose
restriction is the single pattern `(a b)` and whose substitution is the single
pattern `(a c)`.

`splitQuery` maps a parsed document to a restriction list and an optional
substitution list:

| Top-level nodes | Result                                                      | Meaning      |
| --------------- | ----------------------------------------------------------- | ------------ |
| 0               | `restriction = []`, `substitution = null`                   | read         |
| 1               | `restriction = node.values`, `substitution = null`          | read         |
| 2               | `restriction = node₀.values`, `substitution = node₁.values` | substitution |
| > 2             | error                                                       | —            |

When `substitution` is `null`, the query is **read-only** (§4.6).

### 3.1 Pattern slots

Every pattern is a link node, decomposed into three slots `{id, source,
target}`:

| Pattern values   | Has `id`? | Slots                                         |
| ---------------- | --------- | --------------------------------------------- |
| 2 values         | optional  | `{id, source: values[0], target: values[1]}`  |
| 0 values         | optional  | `{id, source: null, target: null}`            |
| 1 value, no `id` | —         | `{id: values[0], source: null, target: null}` |
| any other count  | —         | error                                         |

A `null` slot means "unconstrained" when matching, and "inherit from the matched
link" when producing an update (§4.4). The one-value form `(x)` matches/addresses
a link **by identity only**.

---

## 4. The single substitution operation

There is exactly one operation. The restriction selects existing links (binding
variables); the substitution describes what those links become. The four CRUD
behaviours are not separate primitives — they are derived from how the two
pattern lists line up positionally:

```
create   ()        ((s t))     empty restriction, one created link
read     ((p))                  restriction only, no mutation
update   ((a b))   ((a c))      matched link rewritten in place
delete   ((a b))   ()           matched link with no replacement is removed
```

### 4.1 References in patterns

A reference resolves differently when **matching** versus **producing output**.

**Matching** (`resolveForMatch`) — resolves a reference to a concrete index, or
"cannot resolve":

- number → its integer value.
- name → the index the name is bound to, or unresolved if the name is unknown.
- variable / wildcard → handled by the slot rule below (not by this resolver).
- nested link `(s t)` → resolve `s` and `t`; if both resolve, look up
  `findByPair`; the result is that link's index, or unresolved.

**Producing output** (`resolveForOutput`) — every reference MUST resolve:

- number → its integer value.
- variable → its bound value; an **unbound** variable is an error.
- wildcard → an error (a wildcard MUST NOT appear in a substitution).
- name → the bound index, or a freshly materialised point when auto-create is
  enabled (§5); an error otherwise.
- nested link `(s t)` → resolve `s` and `t` (both MUST resolve); return the
  existing link's index, or **create** a new link as a side effect.

### 4.2 Matching a slot

For a slot `S` and a concrete link value `actual`:

- `S` is `null` → matches (unconstrained).
- `S` is a wildcard → matches.
- `S` is a variable → if already bound in this row, it matches iff its bound
  value equals `actual`; otherwise it binds to `actual` and matches.
- otherwise → `resolveForMatch(S)` MUST be resolved and equal to `actual`.

A pattern matches a link iff its `id` slot matches `link.index`, its `source`
slot matches `link.source`, and its `target` slot matches `link.target`.

### 4.3 Joining the restriction

The restriction is a conjunctive join over the **snapshot** of links taken
_before_ any mutation:

1. Start with one row: empty binding, empty link list.
2. For each pattern in order, and for each current row, try the pattern against
   every link in the snapshot using a copy of the row's binding. Every match
   produces a new row that appends the matched link and the extended binding.
3. The result is the set of surviving rows. Each row records, in pattern order,
   the concrete link matched by each pattern, plus the variable bindings shared
   across the whole row.

This is a Cartesian product filtered by binding consistency: variables shared
between patterns act as join keys. An empty restriction yields exactly one row
(empty binding, no links).

### 4.4 Executing the substitution

Let `paired = min(len(restriction), len(substitution))`. For each row, in row
order:

1. **Update** — for `i` in `[0, paired)`: take `matched = row.links[i]`. If it
   was already removed by an earlier row, skip it. Otherwise materialise
   `substitution[i]` (with `matched` available so a `null` source/target slot
   inherits the matched link's structure) and `update` the matched link's
   identity to the new structure, applying `newIndex` if the substitution
   specified an `id`.
2. **Delete** — for `i` in `[paired, len(restriction))`: delete `row.links[i]`.
3. **Create** — for `i` in `[paired, len(substitution))`: materialise
   `substitution[i]` (no matched link) and `create` it.

Materialisation of a substitution pattern (`materialize`):

- The `id` slot, if present, is resolved for output and used as the explicit
  index (`update`'s `newIndex` or `create`'s `index`).
- If both `source` and `target` slots are `null`: there MUST be a matched link
  (this is an update inheriting structure); the result is the matched link's
  `source`/`target`. Without a matched link this is an error ("a created link
  must specify a source and a target").
- Otherwise both slots are resolved for output.

Because matching uses a pre-mutation snapshot, an operation observes the store as
it was at the start; side-effect link creation during output resolution (§4.1)
is the only way the live store changes mid-operation.

### 4.5 Worked examples

Assume an empty database with auto-create on.

```
() ((alice loves bob))
```

`alice`, `loves`, `bob` are unknown names; output resolution materialises each as
a point (`(1:1 1)`, `(2:2 2)`, `(3:3 3)`). The nested links resolve bottom-up:
`(alice loves)` → a new link `(4: 1 2)`, then `(… bob)` → `(5: 4 3)`. Operation:
**create**.

```
(($i: $s $t))
```

One pattern, all variables, no substitution → **read**. It matches every link,
binding `$i`, `$s`, `$t` to each link's index/source/target.

```
((alice loves bob)) ((alice loves carol))
```

The restriction matches the existing link; the substitution rewrites it in place
to point at a (newly materialised) `carol`. Its index is preserved. Operation:
**update**.

```
((alice loves carol)) ()
```

`paired = 0`, so the matched link falls into the delete pass. Operation:
**delete**.

### 4.6 Read path

When `substitution` is `null`, the query performs the join (§4.3) over the live
store and returns the rows verbatim with no mutation. Keeping read separate from
execute is precisely what lets a lone restriction mean "read" rather than
"delete".

---

## 5. Named references

Indices are convenient for machines but opaque to humans, so a **names** registry
maps labels to indices (mirroring link-cli's sidecar `names.links` file). This
lets a query say `(alice loves bob)` instead of `(7 9 8)`.

- `resolve(name)` → the bound index, or nothing. Used during matching.
- `ensure(name)` → the bound index; if the name is unknown and **auto-create** is
  enabled, allocate an index, bind the name, and materialise the index as a point
  `(i: i i)`. If auto-create is disabled, an unknown name is an error (an
  `UnknownNameError`), which catches typos in production schemas. Used during
  output.
- `bind(name, index)` associates a label with an existing index without
  materialising anything; `nameOf(index)` is the reverse lookup; `entries()`
  enumerates all `[name, index]` pairs.

Auto-create defaults to **on**. It is configured per database/server/CLI
invocation (`autoCreate`, CLI `--no-auto-create`).

---

## 6. Query report

Every executed query returns a structured, JSON-serialisable **report**:

```json
{
  "operation": "update",
  "matched": [
    { "links": [{ "index": 5, "source": 4, "target": 3 }], "binding": {} }
  ],
  "created": [],
  "updated": [{ "index": 5, "source": 4, "target": 6 }],
  "deleted": []
}
```

- **`operation`** — one of `read`, `create`, `update`, `delete`, `mixed`,
  `noop` (§6.1).
- **`matched`** — the join rows: each has `links` (the concrete links matched, in
  pattern order) and `binding` (the variable bindings as `{ name: index }`).
- **`created` / `updated` / `deleted`** — the links created, updated (final
  structure), and removed by this operation. Links created as a side effect of
  resolving nested substitution links also appear in `created`.

### 6.1 Operation classification

- If the query is read-only → `read`.
- Otherwise, collect which of `created`, `updated`, `deleted` are non-empty:
  - none → `noop`
  - exactly one → that one (`create` / `update` / `delete`)
  - more than one → `mixed`

---

## 7. Database surface

A **database** bundles a store (§1.5) and a names registry (§5) and exposes:

| Method               | Behaviour                                                                            |
| -------------------- | ------------------------------------------------------------------------------------ |
| `query(text)`        | Parse, split, execute (or read), emit change events, return a report (§6).           |
| `links()`            | All stored links.                                                                    |
| `count()`            | Number of stored links.                                                              |
| `toLino()`           | Whole database as canonical LiNo, one `(index: source target)` link per line.        |
| `importLino(text)`   | Create each top-level link from LiNo text; returns the count created.                |
| `introspect()`       | `{ linkCount, names: [{ name, index }], links: [...] }` — the LinksQL "schema" (§8). |
| `clear()`            | Remove every link and name.                                                          |
| `onChange(listener)` | Register a change listener; returns an unsubscribe function (§9).                    |

A malformed query MUST raise a query error rather than mutating the store.
Implementations SHOULD distinguish a LiNo syntax error, a query-shape error, and
a substitution error, but all are surfaced to the caller as query failures.

### 7.1 Import semantics

`importLino` treats each top-level node `N` as the query `() (N)`, i.e. a create.
Links written with explicit indices (e.g. `(3: 1 2)`) preserve those indices
subject to the integrity invariants (§1.3); structural duplicates are coalesced.

---

## 8. Introspection

GraphQL exposes a schema; LinksQL exposes its store shape. `introspect()` returns:

- `linkCount` — the number of links.
- `names` — every `{ name, index }` association in the registry.
- `links` — every stored link.

Because everything is a link, there is no separate type system to introspect:
the links _are_ the schema, and named references are the human-facing vocabulary.

---

## 9. Subscriptions

A subscription is the direct replacement for a GraphQL subscription. A subscriber
registers a **restriction pattern**; whenever an operation creates, updates, or
deletes a link that matches the pattern, the subscriber is notified.

- A database emits a change event after any operation that mutated the store
  (i.e. `created`, `updated`, or `deleted` is non-empty). Read-only and no-op
  queries emit nothing.
- The set of **touched** links for an event is the concatenation of its
  `created`, `updated`, and `deleted` links.
- A subscription's restriction is parsed like a query restriction. A touched link
  _matches_ the subscription iff it matches **at least one** pattern of the
  restriction; an **empty** restriction (`()`) matches every touched link.
- For each operation that touches at least one matching link, the subscriber
  receives `{ operation, matching }` where `matching` is the list of touched
  links that matched.

`linkMatches(patterns, link)` formalises the test: empty `patterns` → always
true; otherwise the link must match some pattern (each tried with a fresh
binding).

---

## 10. Triggers

Triggers are server-side reactive rules, unifying link-cli's persistence flags
with subscriptions. A trigger is an ordinary `(restriction) (substitution)` query
plus a **mode**:

| Mode     | link-cli flag | Behaviour                                                                                               |
| -------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `never`  | `--never`     | Read-only. Reports current matches and re-reads on every change; never mutates.                         |
| `once`   | `--once`      | Applies the substitution exactly once, when installed.                                                  |
| `always` | `--always`    | Applies repeatedly to a fixpoint and re-applies on every subsequent change — a standing transformation. |

`TRIGGER_MODES` is exactly `["never", "once", "always"]`.

Behaviour:

- **On install.** `once` fires the substitution once; `always` runs the rule set
  to a fixpoint; `never` performs one read.
- **A `never` rule** runs only the restriction (its read form), never the
  substitution.
- **Fixpoint.** `always` rules are applied repeatedly until a full pass mutates
  nothing. Each pass fires every active rule; if any mutated, another pass runs.
  A rule set that does not stabilise within `maxIterations` (default `1000`)
  raises a trigger error.
- **Reacting to change.** When the database changes from the outside, the rule
  set is re-driven to a fixpoint and every `never` rule re-reads.
- **Re-entrancy guard.** A trigger's own mutations MUST NOT recursively
  re-trigger the rule set; implementations guard with a `firing` flag so a
  fixpoint pass does not observe its own writes as external changes.

An unknown mode is an error. Installing a trigger returns a stable handle that
can later be removed.

---

## 11. HTTP protocol

The reference server exposes a database over plain HTTP. It is OPTIONAL for an
implementation, but those that provide it MUST use these routes and shapes.

| Method + path             | Request                                  | Response                                     |
| ------------------------- | ---------------------------------------- | -------------------------------------------- |
| `GET /`                   | —                                        | `{ name, version, links }` (`links` = count) |
| `POST /query`             | JSON `{ "query": "…" }` or raw LiNo body | the query report (§6)                        |
| `GET /links`              | —                                        | `{ links: [...] }`                           |
| `GET /introspect`         | —                                        | the introspection snapshot (§8)              |
| `POST /import`            | raw LiNo body                            | `{ imported }`                               |
| `GET /export`             | —                                        | `text/plain` canonical LiNo                  |
| `GET /subscribe?pattern=` | restriction in the `pattern` query param | `text/event-stream` (§11.1)                  |

- A `POST /query` body is interpreted as JSON only when the `content-type`
  includes `application/json`; otherwise the raw body is the query text.
- Unknown routes return `404` with `{ error }`. Any thrown error returns `400`
  with `{ error: message }`.

### 11.1 Subscription stream

`GET /subscribe` opens a Server-Sent Events stream:

- The stream opens with the comment line `: linksql stream open` (followed by a
  blank line) to flush headers.
- Each matching change is sent as one SSE frame: `data: <json>` where `<json>` is
  `{ operation, matching }` (§9), terminated by a blank line.
- The default `pattern` is `()` (match every change). Closing the connection
  unsubscribes.

### 11.2 Client

The reference client mirrors the server over `fetch`: `query`, `links`,
`introspect`, `importLino`, and `export` map to the routes above; a non-2xx
response is surfaced as an error using the body's `error` field when present.
`subscribe(pattern, onEvent, { signal })` consumes the SSE stream and returns
`{ ready, done, close }` — `ready` resolves once the stream is open, `done`
settles when it ends, and `close()` aborts it.

---

## 12. Command-line interface

The reference CLI (`linksql`) is a thin wrapper over the database and server:

```
linksql query <lino>   Run a query; prints the JSON report
linksql serve          Start the HTTP server
linksql import <file>  Import LiNo from a file into the store
linksql export         Print the whole store as canonical LiNo
```

Options: `--db <path>` (a LiNo file used as a persistent store, loaded before and
written after the command), `--port <n>` / `--host <host>` (for `serve`),
`--no-auto-create`, `--help`/`-h`, `--version`/`-v`. When `--db` is set, `query`
and `import` persist the resulting store back to the file as canonical LiNo.

---

## 13. Conformance

An implementation is conformant if, for every query, it produces the same store
state and the same report (§6) as this specification describes, given:

- the LiNo grammar and tokenization rules of §2,
- the data model and integrity invariants of §1,
- the matching, join, and substitution semantics of §4,
- the operation classification of §6.1,
- the named-reference and auto-create behaviour of §5.

The HTTP protocol (§11), CLI (§12), subscriptions (§9), and triggers (§10) are
each independently OPTIONAL but, when present, MUST follow the shapes defined
here. The JavaScript implementation in `src/` is the executable reference for all
of the above; `rust/`, `python/`, and `csharp/` are validated against the same
behaviour.
