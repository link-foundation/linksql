"""The single substitution operation.

LinksQL has exactly one operation. A query is a pair of pattern lists — a
**restriction** and a **substitution** — written ``(restriction) (substitution)``.
The restriction selects existing links (binding variables along the way); the
substitution describes what those links become. The four CRUD behaviours are not
separate primitives, they are derived from how the two lists line up:

==========  ==============  ==========================================
behaviour   form            meaning
==========  ==============  ==========================================
create      ``()  ((s t))`` empty restriction, one created link
read        ``((p))``       restriction only, no mutation
update      ``((a b)) ((a c))`` matched link rewritten in place
delete      ``((a b)) ()``  matched link with no replacement is removed
==========  ==============  ==========================================

Patterns are paired positionally: ``restriction[i]`` becomes ``substitution[i]``.
Any trailing restriction patterns are deletions, any trailing substitution
patterns are creations. This positional pairing, combined with variables, makes
the operation a Markov algorithm over the link space — and therefore Turing
complete.

This module is a faithful, behaviourally-identical port of
``src/substitution.js`` from the JavaScript reference implementation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from .lino import Link as LinkNode
from .lino import Node, Ref

if TYPE_CHECKING:
    from .names import Names
    from .store import Link, LinksStore


class SubstitutionError(Exception):
    """Error raised when a substitution cannot be carried out."""


@dataclass
class Context:
    """Execution context shared by the matching and substitution passes.

    ``names`` is optional: when ``None`` named references cannot be resolved
    (matching yields "unresolved", output resolution is an error), mirroring the
    ``ctx.names ?`` guards in the JavaScript reference.
    """

    store: LinksStore
    names: Names | None = None


@dataclass(frozen=True)
class Slots:
    """The three slots of a decomposed link pattern: ``(id, source, target)``.

    A ``None`` slot means "unconstrained" when matching and "inherit from the
    matched link" when producing an update.
    """

    id: Node | None
    source: Node | None
    target: Node | None


@dataclass
class Row:
    """A join row: the concrete links matched and the variable bindings."""

    binding: dict[str, int]
    links: list[Link]


@dataclass
class Spec:
    """A concrete link specification produced by materialising a pattern."""

    index: int | None
    source: int
    target: int


@dataclass
class RawResult:
    """The internal result of :func:`execute`, before report formatting.

    Mirrors the ``{matches, created, updated, deleted}`` object returned by the
    JavaScript ``execute``; exposed as a dataclass so callers use attribute
    access and mypy can check every field.
    """

    matches: list[Row] = field(default_factory=list)
    created: list[Link] = field(default_factory=list)
    updated: list[Link] = field(default_factory=list)
    deleted: list[Link] = field(default_factory=list)


def link_slots(node: Node) -> Slots:
    """Decompose a link pattern node into its three slots.

    A doublet pattern is ``(id: source target)``. The identity slot is optional,
    and a pattern may also be written ``()`` (match anything) or ``(id)`` (match
    a single identity, any structure).
    """
    if not isinstance(node, LinkNode):
        message = "Each restriction/substitution pattern must be a link"
        raise SubstitutionError(message)
    values = node.values
    if len(values) == 2:
        return Slots(id=node.id, source=values[0], target=values[1])
    if len(values) == 0:
        return Slots(id=node.id, source=None, target=None)
    if len(values) == 1 and node.id is None:
        return Slots(id=values[0], source=None, target=None)
    message = f"A link pattern must have 0 or 2 values (got {len(values)})"
    raise SubstitutionError(message)


def _resolve_for_match(
    node: Node | None, binding: dict[str, int], ctx: Context
) -> int | None:
    """Resolve a value node to a concrete link index for *matching* purposes.

    Returns ``None`` when the node cannot resolve.
    """
    if isinstance(node, Ref):
        if node.kind == "number":
            assert isinstance(node.value, int)
            return node.value
        if node.kind == "name":
            assert isinstance(node.value, str)
            return ctx.names.resolve(node.value) if ctx.names is not None else None
        # variables and wildcards are handled by the caller
        return None
    if node is None:
        return None
    slots = link_slots(node)
    source = _resolve_for_match(slots.source, binding, ctx)
    target = _resolve_for_match(slots.target, binding, ctx)
    if source is None or target is None:
        return None
    found = ctx.store.find_by_pair(source, target)
    return found.index if found is not None else None


def _match_slot(
    slot: Node | None, actual: int, binding: dict[str, int], ctx: Context
) -> bool:
    """Constrain one slot of a pattern against an actual value.

    Updates ``binding`` in place when a fresh variable is bound; ``None`` slots
    are unconstrained.
    """
    if slot is None:
        return True
    if isinstance(slot, Ref):
        if slot.kind == "wildcard":
            return True
        if slot.kind == "variable":
            assert isinstance(slot.value, str)
            if slot.value in binding:
                return binding[slot.value] == actual
            binding[slot.value] = actual
            return True
    expected = _resolve_for_match(slot, binding, ctx)
    return expected is not None and expected == actual


def _match_one(
    pattern: Node, link: Link, binding: dict[str, int], ctx: Context
) -> bool:
    """Test a single pattern against a single link, extending ``binding``."""
    slots = link_slots(pattern)
    return (
        _match_slot(slots.id, link.index, binding, ctx)
        and _match_slot(slots.source, link.source, binding, ctx)
        and _match_slot(slots.target, link.target, binding, ctx)
    )


def _join_restriction(
    patterns: list[Node], ctx: Context, snapshot: list[Link]
) -> list[Row]:
    """Join all restriction patterns into a set of binding rows.

    Each row records the concrete link matched by every pattern, in order, so the
    substitution can pair with them positionally.
    """
    rows: list[Row] = [Row(binding={}, links=[])]
    for pattern in patterns:
        nxt: list[Row] = []
        for row in rows:
            for link in snapshot:
                binding = dict(row.binding)
                if _match_one(pattern, link, binding, ctx):
                    nxt.append(Row(binding=binding, links=[*row.links, link]))
        rows = nxt
    return rows


def _resolve_for_output(
    node: Node, binding: dict[str, int], ctx: Context, created: list[Link]
) -> int:
    """Resolve a value node to a concrete index when *producing* output.

    Unlike matching, every reference must resolve: unbound variables and
    wildcards are errors, and names are auto-created when the context allows it.
    Links created as a side effect are appended to ``created``.
    """
    if isinstance(node, Ref):
        if node.kind == "number":
            assert isinstance(node.value, int)
            return node.value
        if node.kind == "variable":
            assert isinstance(node.value, str)
            if node.value not in binding:
                message = f"Unbound variable ${node.value} in substitution"
                raise SubstitutionError(message)
            return binding[node.value]
        if node.kind == "wildcard":
            message = "Wildcard * cannot appear in a substitution"
            raise SubstitutionError(message)
        assert isinstance(node.value, str)
        if ctx.names is None:
            message = f'Named reference "{node.value}" requires names to be enabled'
            raise SubstitutionError(message)
        return ctx.names.ensure(node.value)
    slots = link_slots(node)
    if slots.source is None or slots.target is None:
        message = "Nested link must have a source and a target"
        raise SubstitutionError(message)
    source = _resolve_for_output(slots.source, binding, ctx, created)
    target = _resolve_for_output(slots.target, binding, ctx, created)
    index = (
        None
        if slots.id is None
        else _resolve_for_output(slots.id, binding, ctx, created)
    )
    existing = ctx.store.find_by_pair(source, target)
    if existing is not None:
        return existing.index
    link = ctx.store.create(index=index, source=source, target=target)
    created.append(link)
    return link.index


def _materialize(
    pattern: Node,
    binding: dict[str, int],
    ctx: Context,
    created: list[Link],
    matched: Link | None = None,
) -> Spec:
    """Turn a substitution pattern into a concrete ``Spec``.

    ``matched`` is the link being rewritten (for an update); when both
    source/target slots are ``None`` the spec inherits its structure.
    """
    slots = link_slots(pattern)
    index = (
        None
        if slots.id is None
        else _resolve_for_output(slots.id, binding, ctx, created)
    )
    if slots.source is None or slots.target is None:
        if matched is None:
            message = "A created link must specify a source and a target"
            raise SubstitutionError(message)
        return Spec(index=index, source=matched.source, target=matched.target)
    source = _resolve_for_output(slots.source, binding, ctx, created)
    target = _resolve_for_output(slots.target, binding, ctx, created)
    return Spec(index=index, source=source, target=target)


def match_restriction(restriction: list[Node], ctx: Context) -> list[Row]:
    """Match a restriction against the store without mutating anything.

    This is the read path: a query with a restriction but no substitution returns
    its matches verbatim. Keeping it separate from :func:`execute` is what lets a
    lone restriction mean "read" rather than "delete".
    """
    return _join_restriction(restriction, ctx, ctx.store.all())


def link_matches(patterns: list[Node], link: Link, ctx: Context) -> bool:
    """Test whether a link satisfies at least one of the given patterns.

    Each pattern is tried with a fresh binding. An empty pattern list always
    matches.
    """
    if len(patterns) == 0:
        return True
    return any(_match_one(pattern, link, {}, ctx) for pattern in patterns)


def execute(
    restriction: list[Node], substitution: list[Node], ctx: Context
) -> RawResult:
    """Execute one substitution operation against the store."""
    snapshot = ctx.store.all()
    rows = _join_restriction(restriction, ctx, snapshot)
    result = RawResult()
    paired = min(len(restriction), len(substitution))

    for row in rows:
        result.matches.append(Row(binding=row.binding, links=row.links))

        for i in range(paired):
            matched = row.links[i]
            if not ctx.store.has(matched.index):
                continue  # already removed by an earlier row
            spec = _materialize(
                substitution[i], row.binding, ctx, result.created, matched
            )
            result.updated.append(
                ctx.store.update(
                    matched.index,
                    source=spec.source,
                    target=spec.target,
                    new_index=spec.index,
                )
            )

        for i in range(paired, len(restriction)):
            matched = row.links[i]
            if ctx.store.delete(matched.index):
                result.deleted.append(matched)

        for i in range(paired, len(substitution)):
            spec = _materialize(substitution[i], row.binding, ctx, result.created)
            result.created.append(
                ctx.store.create(
                    index=spec.index, source=spec.source, target=spec.target
                )
            )

    return result
