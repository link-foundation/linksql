# LinksQL

LinksQL is an associative query language and reference implementation built
around a **single substitution operation**. It aims to be as customizable as
[GraphQL](https://graphql.org), yet simpler, more universal, and more adaptive —
in the spirit of [link-cli](https://github.com/link-foundation/link-cli).

Where GraphQL needs separate query, mutation, and subscription type systems,
LinksQL expresses **read, create, update, and delete** with one operation:
pairing a _restriction_ (what to match) with a _substitution_ (what it becomes).

```
(restriction) (substitution)
```

That single rule is Turing-complete (it is a Markov algorithm over an
associative store), so it scales from one-line reads to complex multi-pattern
rewrites without new syntax.

## Data model: links and doublets

Everything is a **link** — an ordered pair stored as `(index: source target)`,
where `index`, `source`, and `target` are positive integers referring to other
links. A link that points at itself, `(i: i i)`, is a **point** — the atom of
the model. This is the _doublet_ associative model used across
[deep-foundation](https://github.com/deep-foundation) and
[link-foundation](https://github.com/link-foundation).

Links are written and parsed with **Links Notation (LiNo)**:

```
(1: 1 1)          // a point with index 1
(3: 1 2)          // link 3 connects 1 -> 2
(alice loves bob) // names are auto-created as points, then linked
($i: $s $t)       // $-prefixed tokens are variables for matching
(* * *)           // * is a wildcard that matches anything
```

## The single substitution operation

A query is a restriction pattern followed by a substitution pattern. The two
sides are paired positionally, and the difference between them determines the
operation:

| Query shape                       | Operation  | Meaning                                |
| --------------------------------- | ---------- | -------------------------------------- |
| `(pattern)`                       | **read**   | match without mutating                 |
| `() ((a b c))`                    | **create** | substitution with no restriction       |
| `((a b c)) ((a b d))`             | **update** | rewrite matches in place, keeping ids  |
| `((a b c)) ()`                    | **delete** | restriction with no substitution       |
| multiple pairs of differing kinds | **mixed**  | several substitutions in one statement |

Every execution returns a structured `QueryReport`:

```js
{
  operation: 'update',
  matched:  [{ links: [...], binding: { s: 1, t: 2 } }],
  created:  [],
  updated:  [{ index: 3, source: 1, target: 4 }],
  deleted:  []
}
```

## Quick start

LinksQL has **zero runtime dependencies** — the library uses only the
JavaScript standard library, the server uses `node:http`, and the client uses
the global `fetch` (Node.js 20+, Bun, Deno, and browsers).

### Install

```bash
npm install @link-foundation/linksql
```

### Use as a library

```js
import { createDatabase } from '@link-foundation/linksql';

const db = createDatabase();

// CREATE — named references are auto-created as points first
db.query('() ((alice loves bob))');

// READ — variables bind to matching links
const read = db.query('(($i: $s $t))');
console.log(read.matched.map((m) => m.binding));

// UPDATE — rewrite in place, keeping the link id
db.query('((alice loves bob)) ((alice loves carol))');

// DELETE — trailing empty substitution removes the match
db.query('((alice loves carol)) ()');

// INTROSPECT — the LinksQL answer to a GraphQL schema
console.log(db.introspect());
```

See [`examples/basic-usage.js`](examples/basic-usage.js) for a runnable version.

### Use the CLI

```bash
# Run a query against an in-memory store
npx linksql query '() ((1 1))'

# Persist to a file between invocations
npx linksql --db-file links.json query '() ((alice loves bob))'
npx linksql --db-file links.json query '(($i: $s $t))'

# Import / export the whole store as Links Notation
npx linksql --db-file links.json export
npx linksql import links.lino

# Serve the HTTP API
npx linksql serve --port 4000
```

### Use the HTTP server and client

```js
import { startServer, LinksQLClient } from '@link-foundation/linksql';

const server = startServer({ port: 4000 });

const client = new LinksQLClient('http://localhost:4000');
await client.query('() ((alice loves bob))');

// Subscriptions stream changes filtered by a restriction (GraphQL
// subscriptions, replaced by Server-Sent Events over the same operation).
for await (const change of client.subscribe('(($i: $s $t))')) {
  console.log('changed:', change);
}
```

## Reference implementations

The single specification, [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md), is
backed by four behaviourally identical implementations so LinksQL can be adopted
from any of the targeted ecosystems:

| Language   | Directory | Tests & lint                           |
| ---------- | --------- | -------------------------------------- |
| JavaScript | `src/`    | `npm test`, ESLint + Prettier          |
| Rust       | `rust/`   | `cargo test`, `clippy`, `rustfmt`      |
| Python     | `python/` | `pytest`, `ruff`, `mypy`               |
| C#         | `csharp/` | `dotnet test` (xUnit), `dotnet format` |

Each implementation provides the same parser, store, substitution engine, and
query executor. The JavaScript package additionally ships the HTTP server,
client, and CLI described above.

## Project structure

```
.
├── docs/
│   ├── SPECIFICATION.md     # The LinksQL language specification
│   ├── CONTRIBUTING.md
│   └── BEST-PRACTICES.md
├── src/                     # JavaScript reference implementation
│   ├── lino.js              # Links Notation parser/serializer
│   ├── store.js             # In-memory links store (doublets)
│   ├── names.js             # Named-reference resolution
│   ├── substitution.js      # Single substitution engine
│   ├── query.js             # Query executor + Database
│   ├── triggers.js          # Subscriptions and triggers
│   ├── server.js            # node:http server
│   ├── client.js            # fetch-based client
│   ├── index.js             # Public API
│   └── index.d.ts           # TypeScript definitions
├── bin/linksql.js           # CLI entry point
├── rust/  python/  csharp/  # Other reference implementations
├── examples/
│   ├── basic-usage.js
│   └── universal-app/       # React + GitHub Pages + Electron + Capacitor
└── tests/                   # Cross-runtime JavaScript tests
```

## Specification

The full language reference — data model, Links Notation grammar, the
substitution algorithm, operation classification, introspection, subscriptions,
and triggers — lives in [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md). All
implementations are validated against it.

## Multi-runtime support

The JavaScript implementation works identically on every major runtime, using
[test-anywhere](https://github.com/link-foundation/test-anywhere) for a unified
testing API:

- **Bun**: `bun test --timeout 30000`
- **Node.js**: `npm test` (`node --test --test-timeout=30000`)
- **Deno**: `deno test --allow-read`

## Example app

[`examples/universal-app`](examples/universal-app) is a Vite + React playground
that imports the LinksQL query executor from `src/query.js` and runs the single
substitution operation against an in-memory database in the browser. The same
static build is reused by three targets:

- GitHub Pages (`npm run example:web:build`)
- Electron desktop packaging (`npm run example:desktop:package`)
- Capacitor Android/iOS sync (`npm run example:mobile:sync`)

It imports `src/query.js` directly (never `src/index.js`) so the Node-only HTTP
server stays out of the browser bundle. See
[`examples/universal-app/README.md`](examples/universal-app/README.md) for local
web, desktop, Android, and iOS testing instructions.

### Auto-regenerated preview screenshots

The `example-app.yml` workflow contains a `preview-regen` job that boots the
built example app in a headless Chromium via
[`browser-commander`](https://www.npmjs.com/package/browser-commander) +
Playwright and writes fresh screenshots to
`docs/screenshots/example-app/example-app-{locale}-{theme}.png` on every push to
`main` (and on `workflow_dispatch`). Any drift is committed back to `main` with
`[skip ci]` so README/site images never go stale between releases. The job runs
in the official Playwright container with the browser already installed,
avoiding CI stalls from live Chromium downloads.

The same script is available locally:

```bash
npm install --prefix examples/universal-app
npm run example:web:preview-images
# Verbose probe of <html data-theme>, <html lang>, and PNG signatures:
PREVIEW_VERBOSE=1 npm run example:web:preview-images
```

## CI/CD pipeline

The release workflow (`.github/workflows/release.yml`) implements a fast-fail
pipeline reused from the link-foundation AI-driven-development templates:

**Fast checks** (run first for fastest feedback):

1. **Test compilation** — syntax-checks all source with `node --check`
2. **Lint, format & secrets scan** — ESLint, Prettier, jscpd, and
   [secretlint](https://github.com/secretlint/secretlint)
3. **File line limits** — enforces a 1500-line limit on JS and Markdown files
4. **Changeset check** — validates the PR adds exactly one changeset
5. **Version check** — blocks manual version changes in `package.json`
6. **Documentation validation** — checks required doc files exist

**Slow checks** (only after fast checks pass):

7. **Test matrix** — 3 runtimes × 3 OS = 9 JavaScript test combinations, plus
   the Rust, Python, and C# implementation test jobs
8. **Broken link checks** — validates all links in Markdown/HTML files

**Release** (on merge to `main`): changeset merge, automated versioning, and npm
publishing via OIDC trusted publishing.

See [docs/BEST-PRACTICES.md](docs/BEST-PRACTICES.md) for detailed explanations of
each practice.

## Contributing

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for detailed guidelines. Quick
steps:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes (and update the specification if semantics change)
4. Create a changeset: `npm run changeset`
5. Commit your changes (pre-commit hooks will run automatically)
6. Push and create a Pull Request

## License

[Unlicense](LICENSE) - Public Domain
