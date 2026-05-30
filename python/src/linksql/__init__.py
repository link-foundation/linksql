"""LinksQL — a Python reference implementation.

LinksQL is an associative query language built on **one data primitive** (the
link, a doublet) and **one operation** (substitution). This package is a
faithful, behaviourally-identical port of the JavaScript reference implementation
in ``../src``; the normative specification lives in ``../docs/SPECIFICATION.md``.

The public surface mirrors the JavaScript package entry point: parse and
serialise LiNo, build a :class:`LinksStore`, and run queries through a
:class:`Database`.
"""

from __future__ import annotations

from .lino import (
    Link as LinkNode,
)
from .lino import (
    LinoSyntaxError,
    Node,
    Ref,
    Token,
    parse,
    serialize,
    serialize_all,
    tokenize,
)
from .names import Names, UnknownNameError
from .query import (
    Database,
    Introspection,
    MatchRow,
    QueryError,
    QueryReport,
    SplitQuery,
    link_to_lino,
    patterns_of,
    split_query,
)
from .store import Link, LinkIntegrityError, LinksStore
from .substitution import (
    Context,
    RawResult,
    Row,
    Slots,
    Spec,
    SubstitutionError,
    execute,
    link_matches,
    link_slots,
    match_restriction,
)

__version__ = "0.1.0"

__all__ = [
    "Context",
    "Database",
    "Introspection",
    "Link",
    "LinkIntegrityError",
    "LinkNode",
    "LinksStore",
    "LinoSyntaxError",
    "MatchRow",
    "Names",
    "Node",
    "QueryError",
    "QueryReport",
    "RawResult",
    "Ref",
    "Row",
    "Slots",
    "Spec",
    "SplitQuery",
    "SubstitutionError",
    "Token",
    "UnknownNameError",
    "__version__",
    "execute",
    "link_matches",
    "link_slots",
    "link_to_lino",
    "match_restriction",
    "parse",
    "patterns_of",
    "serialize",
    "serialize_all",
    "split_query",
    "tokenize",
]
