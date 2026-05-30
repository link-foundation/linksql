"""High-level query executor: the public face of the engine.

A :class:`Database` bundles a links store with a name registry and exposes a
single :meth:`Database.query` method that accepts LiNo text. The text is parsed
into a restriction and a substitution, the operation runs, and a structured
report comes back describing what matched and what changed.

This module is a faithful, behaviourally-identical port of ``src/query.js`` from
the JavaScript reference implementation.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from typing import Callable

from .lino import Link as LinkNode
from .lino import LinoSyntaxError, Node, Ref, parse, serialize
from .names import Names
from .store import Link, LinksStore
from .substitution import (
    Context,
    RawResult,
    Row,
    SubstitutionError,
    execute,
    match_restriction,
)


class QueryError(Exception):
    """Error raised when query text is well-formed LiNo but not a valid query."""


@dataclass
class SplitQuery:
    """A parsed query split into a restriction and an optional substitution."""

    restriction: list[Node]
    substitution: list[Node] | None


@dataclass
class MatchRow:
    """One row of a query's matches: the matched links and the bindings."""

    links: list[Link]
    binding: dict[str, int]


@dataclass
class QueryReport:
    """A structured report describing what a query matched and changed.

    Every :class:`~linksql.store.Link` in the report is a copy, so mutating the
    store after a query never aliases the reported links.
    """

    operation: str
    matched: list[MatchRow] = field(default_factory=list)
    created: list[Link] = field(default_factory=list)
    updated: list[Link] = field(default_factory=list)
    deleted: list[Link] = field(default_factory=list)


@dataclass
class Introspection:
    """A snapshot of the database for introspection tooling.

    ``link_count`` is the Python-idiomatic name for the JavaScript
    ``linkCount``; ``names`` is a list of ``{"name", "index"}`` dicts and
    ``links`` enumerates every stored link.
    """

    link_count: int
    names: list[dict[str, object]]
    links: list[Link]


def patterns_of(node: Node) -> list[Node]:
    """Extract the pattern list from a restriction/substitution wrapper node."""
    if not isinstance(node, LinkNode) or node.id is not None:
        message = (
            "A restriction or substitution must be a parenthesised list of patterns"
        )
        raise QueryError(message)
    return node.values


def split_query(nodes: list[Node]) -> SplitQuery:
    """Split parsed LiNo nodes into a restriction and optional substitution.

    One top-level value is a read (restriction only). Two values are the
    canonical ``(restriction) (substitution)`` form. Anything else is ambiguous.
    """
    if len(nodes) == 0:
        return SplitQuery(restriction=[], substitution=None)
    if len(nodes) == 1:
        return SplitQuery(restriction=patterns_of(nodes[0]), substitution=None)
    if len(nodes) == 2:
        return SplitQuery(
            restriction=patterns_of(nodes[0]),
            substitution=patterns_of(nodes[1]),
        )
    message = 'A query must be "(restriction)" or "(restriction) (substitution)"'
    raise QueryError(message)


def _link_to_node(link: Link) -> LinkNode:
    """Convert a stored link to its canonical LiNo node."""
    return LinkNode(
        id=Ref(kind="number", value=link.index),
        values=[
            Ref(kind="number", value=link.source),
            Ref(kind="number", value=link.target),
        ],
    )


def link_to_lino(link: Link) -> str:
    """Serialise a link to canonical LiNo text, e.g. ``(3: 1 2)``."""
    return serialize(_link_to_node(link))


def _classify(raw: RawResult, read_only: bool) -> str:
    """Classify a change report into a human-friendly operation name."""
    if read_only:
        return "read"
    kinds = [
        name
        for name, links in (
            ("create", raw.created),
            ("update", raw.updated),
            ("delete", raw.deleted),
        )
        if links
    ]
    if len(kinds) == 0:
        return "noop"
    return kinds[0] if len(kinds) == 1 else "mixed"


def _copy_link(link: Link) -> Link:
    """Return an independent copy of a link so reports never alias the store."""
    return dataclasses.replace(link)


def _copy_row(row: Row) -> MatchRow:
    """Copy a join row into a report row, copying every matched link."""
    return MatchRow(
        links=[_copy_link(link) for link in row.links],
        binding=dict(row.binding),
    )


ChangeListener = Callable[[QueryReport], None]


class Database:
    """An associative database queried with the single substitution operation."""

    def __init__(self, *, auto_create: bool = True) -> None:
        self.store = LinksStore()
        self.names = Names(self.store, auto_create=auto_create)
        self.listeners: list[ChangeListener] = []

    @property
    def context(self) -> Context:
        """The execution context passed to the engine."""
        return Context(store=self.store, names=self.names)

    def on_change(self, listener: ChangeListener) -> Callable[[], None]:
        """Register a change listener; return an unsubscribe function."""
        self.listeners.append(listener)

        def unsubscribe() -> None:
            self.listeners = [
                existing for existing in self.listeners if existing is not listener
            ]

        return unsubscribe

    def emit(self, report: QueryReport) -> None:
        """Notify listeners about the changes produced by an operation."""
        if report.created or report.updated or report.deleted:
            for listener in self.listeners:
                listener(report)

    def query(self, text: str) -> QueryReport:
        """Run a LinksQL query expressed as LiNo text."""
        try:
            nodes = parse(text)
        except LinoSyntaxError as error:
            message = f"Invalid LiNo: {error}"
            raise QueryError(message) from error
        split = split_query(nodes)
        read_only = split.substitution is None
        try:
            if read_only:
                raw = RawResult(
                    matches=match_restriction(split.restriction, self.context)
                )
            else:
                assert split.substitution is not None
                raw = execute(split.restriction, split.substitution, self.context)
        except SubstitutionError as error:
            raise QueryError(str(error)) from error
        report = QueryReport(
            operation=_classify(raw, read_only),
            matched=[_copy_row(row) for row in raw.matches],
            created=[_copy_link(link) for link in raw.created],
            updated=[_copy_link(link) for link in raw.updated],
            deleted=[_copy_link(link) for link in raw.deleted],
        )
        self.emit(report)
        return report

    def links(self) -> list[Link]:
        """All stored links."""
        return self.store.all()

    def count(self) -> int:
        """Number of links currently stored."""
        return self.store.size

    def to_lino(self) -> str:
        """Serialise the whole database to canonical LiNo, one link per line."""
        return "\n".join(link_to_lino(link) for link in self.store.all())

    def import_lino(self, text: str) -> int:
        """Bulk-import links from LiNo text (each top-level link is created)."""
        nodes = parse(text)
        count = 0
        for node in nodes:
            report = self.query(f"() ({serialize(node)})")
            count += len(report.created)
        return count

    def introspect(self) -> Introspection:
        """Describe the database for introspection tooling."""
        return Introspection(
            link_count=self.store.size,
            names=[
                {"name": name, "index": index} for name, index in self.names.entries()
            ],
            links=self.store.all(),
        )

    def clear(self) -> None:
        """Remove every link and name."""
        self.store.clear()
        self.names.by_name.clear()
        self.names.by_index.clear()
