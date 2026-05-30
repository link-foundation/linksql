# LinksQL (Python reference implementation)

A faithful, behaviourally-identical Python port of the JavaScript reference
implementation of **LinksQL** — an associative query language built on **one data
primitive** (the link, a doublet) and **one operation** (substitution).

Everything is a link: a triple `(index: source target)` of positive integers. A
link whose `source` and `target` both equal its own `index` is a *point*, the
atom of the graph. A query is a pair of pattern lists — a *restriction* and a
*substitution* — written `(restriction) (substitution)`; the four CRUD
behaviours (read, create, update, delete) are derived from how the two lists line
up positionally.

The JavaScript implementation in `../src` is the ground truth, and the normative
behaviour is defined in [`../docs/SPECIFICATION.md`](../docs/SPECIFICATION.md).

## Quick start

```python
from linksql import Database

db = Database()
db.query("() ((alice loves bob))")   # create
report = db.query("(($s $r $t))")    # read every relation
print(report.operation, report.matched)
```

## Development

This package uses a src layout. Create a virtual environment and install it with
the development extras:

```bash
python -m venv .venv
. .venv/bin/activate
pip install -e ".[dev]"
```

Then run the checks (all must pass):

```bash
ruff check .
ruff format --check .
mypy src
pytest tests/ -v
```

## Public API

The top-level `linksql` package re-exports the engine surface:

- `linksql.lino` — `tokenize`, `parse`, `serialize`, `serialize_all`, the AST
  types (`Ref`, `Link`/`LinkNode`, `Node`, `Token`) and `LinoSyntaxError`.
- `linksql.store` — `LinksStore`, `Link`, `LinkIntegrityError`.
- `linksql.names` — `Names`, `UnknownNameError`.
- `linksql.substitution` — `link_slots`, `match_restriction`, `execute`,
  `link_matches`, `Context`, and `SubstitutionError`.
- `linksql.query` — `Database`, `split_query`, `link_to_lino`, `QueryReport`,
  `QueryError`.
