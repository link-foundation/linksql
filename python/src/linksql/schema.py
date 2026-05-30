"""LinksQL schemas — the GraphQL-class API layer.

The issue asks LinksQL to be "robust enough to replace GraphQL", which means
offering the features developers expect from GraphQL: a declarative schema,
introspection, and named operations and subscriptions. This module supplies the
schema data model; the JavaScript reference additionally turns a schema into a
running server, but the Python port is engine-only and therefore ports only the
schema itself (parse, introspect, render and the lookups around it).

A schema is itself written in Links Notation (the data protocol), so the same
notation describes data *and* the shape of the API that serves it::

    (schema social
      (type Person)
      (type Post)
      (relation name (from Person) (to Text))
      (relation author (from Post) (to Person))
      (relation likes (from Person) (to Post))
      (query everyone (($p: $p $p)))
      (subscription newLikes ((1 $post))))

The GraphQL analogy is direct:

- ``type``         ⇔ object type
- ``relation``     ⇔ a typed field/edge (``from`` → ``to``)
- a scalar type    ⇔ any relation endpoint that is not a declared object type
- ``query``        ⇔ a named, reusable read (a query template)
- ``subscription`` ⇔ a named live feed (a restriction streamed as it changes)
- ``introspect()`` ⇔ the ``__schema`` introspection document

This module is a faithful, behaviourally-identical port of ``src/schema.js`` from
the JavaScript reference implementation (minus the server generation).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .lino import Link as LinkNode
from .lino import LinoSyntaxError, Node, Ref, parse, serialize, serialize_all


class SchemaError(Exception):
    """Error raised when a schema is malformed or violated."""


# The declaration keywords a schema understands.
_KEYWORDS = ("type", "relation", "query", "subscription")


@dataclass
class Relation:
    """A typed relation (the GraphQL field/edge): ``from`` → ``to``."""

    name: str
    source: str
    target: str


@dataclass
class NamedQuery:
    """A named, reusable read — a query template."""

    name: str
    text: str


@dataclass
class NamedSubscription:
    """A named live feed — a restriction streamed as it changes."""

    name: str
    pattern: str


def _ref_name(node: Node | None, context: str) -> str:
    """Read a reference node's name as a string.

    Variable references render as ``$name``; every other reference yields its
    textual value. A non-reference node is an error.
    """
    if not isinstance(node, Ref):
        message = f"Expected a name for {context}"
        raise SchemaError(message)
    if node.kind == "variable":
        return f"${node.value}"
    return str(node.value)


def _named_arg(values: list[Node], keyword: str, context: str) -> str:
    """Find a ``(keyword value)`` sub-link and return the value's name.

    Missing or malformed arguments raise a :class:`SchemaError` describing which
    relation is incomplete.
    """
    for value in values:
        if (
            isinstance(value, LinkNode)
            and len(value.values) == 2
            and isinstance(value.values[0], Ref)
            and str(value.values[0].value) == keyword
        ):
            return _ref_name(value.values[1], f"{keyword} of {context}")
    message = f'Relation "{context}" is missing its "{keyword}" type'
    raise SchemaError(message)


@dataclass
class _Buckets:
    """The accumulating declaration collections used while parsing."""

    types: list[str] = field(default_factory=list)
    relations: list[Relation] = field(default_factory=list)
    queries: list[NamedQuery] = field(default_factory=list)
    subscriptions: list[NamedSubscription] = field(default_factory=list)


def _collect_declaration(declaration: Node, buckets: _Buckets) -> None:
    """Sort one ``(keyword ...)`` declaration link into the right collection."""
    if not isinstance(declaration, LinkNode) or len(declaration.values) == 0:
        message = "Each schema declaration must be a link"
        raise SchemaError(message)
    keyword = _ref_name(declaration.values[0], "declaration keyword")
    if keyword not in _KEYWORDS:
        expected = "|".join(_KEYWORDS)
        message = f'Unknown schema declaration "{keyword}" (expected {expected})'
        raise SchemaError(message)
    rest = declaration.values[1:]
    if keyword == "type":
        buckets.types.append(_ref_name(rest[0] if rest else None, "type name"))
    elif keyword == "relation":
        relation_name = _ref_name(rest[0] if rest else None, "relation name")
        buckets.relations.append(
            Relation(
                name=relation_name,
                source=_named_arg(rest, "from", relation_name),
                target=_named_arg(rest, "to", relation_name),
            )
        )
    elif keyword == "query":
        buckets.queries.append(
            NamedQuery(
                name=_ref_name(rest[0] if rest else None, "query name"),
                text=serialize_all(rest[1:], " "),
            )
        )
    else:
        buckets.subscriptions.append(
            NamedSubscription(
                name=_ref_name(rest[0] if rest else None, "subscription name"),
                pattern=serialize_all(rest[1:], " "),
            )
        )


def _infer_scalars(relations: list[Relation], types: list[str]) -> list[str]:
    """Derive scalar type names: relation endpoints not declared as object types.

    Endpoints are reported in first-seen order with duplicates removed.
    """
    scalars: list[str] = []
    for relation in relations:
        for endpoint in (relation.source, relation.target):
            if endpoint not in types and endpoint not in scalars:
                scalars.append(endpoint)
    return scalars


@dataclass
class Schema:
    """A declarative description of a LinksQL API."""

    name: str | None = None
    types: list[str] = field(default_factory=list)
    scalars: list[str] = field(default_factory=list)
    relations: list[Relation] = field(default_factory=list)
    queries: list[NamedQuery] = field(default_factory=list)
    subscriptions: list[NamedSubscription] = field(default_factory=list)

    @classmethod
    def parse(cls, text: str) -> Schema:
        """Parse a schema written in Links Notation."""
        try:
            nodes = parse(text)
        except LinoSyntaxError as error:
            message = f"Invalid LiNo schema: {error}"
            raise SchemaError(message) from error
        root = _schema_root(nodes)
        values = list(root.values)
        head = values.pop(0) if values else None
        if not isinstance(head, Ref) or str(head.value) != "schema":
            message = "A schema must start with the `schema` keyword"
            raise SchemaError(message)
        # An optional bare name may follow the `schema` keyword.
        name: str | None = None
        if values and isinstance(values[0], Ref):
            name = _ref_name(values.pop(0), "schema name")

        buckets = _Buckets()
        for declaration in values:
            _collect_declaration(declaration, buckets)
        scalars = _infer_scalars(buckets.relations, buckets.types)

        return cls(
            name=name,
            types=buckets.types,
            scalars=scalars,
            relations=buckets.relations,
            queries=buckets.queries,
            subscriptions=buckets.subscriptions,
        )

    def relation(self, name: str) -> Relation | None:
        """Look up a relation by name."""
        for relation in self.relations:
            if relation.name == name:
                return relation
        return None

    def query(self, name: str) -> NamedQuery | None:
        """Look up a named query."""
        for query in self.queries:
            if query.name == name:
                return query
        return None

    def subscription(self, name: str) -> NamedSubscription | None:
        """Look up a named subscription."""
        for sub in self.subscriptions:
            if sub.name == name:
                return sub
        return None

    def knows(self, name: str) -> bool:
        """Whether a name is a declared type, scalar or relation."""
        return (
            name in self.types
            or name in self.scalars
            or any(relation.name == name for relation in self.relations)
        )

    def validate_relation(self, name: str) -> Relation:
        """Assert that a relation is declared, raising otherwise."""
        relation = self.relation(name)
        if relation is None:
            message = f'Unknown relation "{name}"'
            raise SchemaError(message)
        return relation

    def introspect(self) -> dict[str, object]:
        """Describe the schema for introspection tooling — the ``__schema`` analogue.

        The returned value is JSON-shaped and therefore travels over the wire as
        Links Notation like every other payload.
        """
        return {
            "name": self.name,
            "types": list(self.types),
            "scalars": list(self.scalars),
            "relations": [
                {"name": r.name, "from": r.source, "to": r.target}
                for r in self.relations
            ],
            "queries": [{"name": q.name, "text": q.text} for q in self.queries],
            "subscriptions": [
                {"name": s.name, "pattern": s.pattern} for s in self.subscriptions
            ],
        }

    def to_lino(self) -> str:
        """Render the schema back to canonical Links Notation."""
        declarations: list[str] = [
            f"(type {serialize(Ref(kind='name', value=type_name))})"
            for type_name in self.types
        ]
        declarations.extend(
            f"(relation {r.name} (from {r.source}) (to {r.target}))"
            for r in self.relations
        )
        declarations.extend(f"(query {q.name} {q.text})" for q in self.queries)
        declarations.extend(
            f"(subscription {s.name} {s.pattern})" for s in self.subscriptions
        )
        head = f"schema {self.name}" if self.name else "schema"
        return "(" + " ".join([head, *declarations]) + ")"


def _schema_root(nodes: list[Node]) -> LinkNode:
    """Return the single top-level ``(schema ...)`` link or raise."""
    if len(nodes) != 1 or not isinstance(nodes[0], LinkNode):
        message = "A schema must be a single `(schema ...)` link"
        raise SchemaError(message)
    return nodes[0]
