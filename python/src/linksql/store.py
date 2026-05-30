"""In-memory doublets store.

The associative data model used by LinksQL is built from a single primitive: the
**link** (a doublet). Every link is a triple::

    (index: source target)

where ``index`` is the link's own unique identity and ``source``/``target`` are
the indices of the linked links. A link whose source and target both equal its
own index is a *point* — the atomic node of the graph.

The store owns identity allocation and enforces the associative invariant that a
``(source, target)`` pair identifies at most one link (deduplication). It is a
pure data container: pattern matching and the substitution operation live in
:mod:`linksql.substitution`, which only relies on the read/write surface defined
here.

This module is a faithful, behaviourally-identical port of ``src/store.js`` from
the JavaScript reference implementation.
"""

from __future__ import annotations

from dataclasses import dataclass


class LinkIntegrityError(Exception):
    """Error raised when a store operation would violate model integrity."""


@dataclass
class Link:
    """A single link: a triple ``(index: source target)`` of positive integers."""

    index: int
    source: int
    target: int


def _is_integer(value: object) -> bool:
    """Return whether ``value`` is an integer (and not a ``bool``).

    JavaScript's ``Number.isInteger`` rejects non-numbers; in Python ``bool`` is
    a subclass of ``int``, so exclude it explicitly to keep the integrity checks
    faithful (a boolean is never a valid index).
    """
    return isinstance(value, int) and not isinstance(value, bool)


class LinksStore:
    """A mutable set of links addressed by integer identity."""

    def __init__(self) -> None:
        # Insertion order is preserved by Python's ``dict`` natively, matching
        # the JavaScript ``Map`` iteration order used by ``all()``.
        self.links: dict[int, Link] = {}
        self.by_pair: dict[tuple[int, int], int] = {}
        # Next identity to hand out; kept above every used index.
        self.next_index: int = 1

    @property
    def size(self) -> int:
        """Number of stored links."""
        return len(self.links)

    def has(self, index: int) -> bool:
        """Return whether a link with this identity exists."""
        return index in self.links

    def get(self, index: int) -> Link | None:
        """Fetch a link by identity, or ``None`` when absent."""
        return self.links.get(index)

    def find_by_pair(self, source: int, target: int) -> Link | None:
        """Look up a link by its ``(source, target)`` structure."""
        index = self.by_pair.get((source, target))
        if index is None:
            return None
        return self.links.get(index)

    def all(self) -> list[Link]:
        """Return all links in insertion order."""
        return list(self.links.values())

    def allocate_index(self) -> int:
        """Reserve a fresh identity, advancing the allocator past it."""
        while self.next_index in self.links:
            self.next_index += 1
        index = self.next_index
        self.next_index += 1
        return index

    def reserve_index(self, index: int) -> None:
        """Keep the allocator above an externally chosen identity."""
        if index >= self.next_index:
            self.next_index = index + 1

    def create(
        self,
        *,
        source: int,
        target: int,
        index: int | None = None,
    ) -> Link:
        """Create (or, by deduplication, return) a link."""
        if not _is_integer(source) or not _is_integer(target):
            message = "Link source and target must be integers"
            raise LinkIntegrityError(message)
        existing = self.find_by_pair(source, target)
        if existing is not None:
            if index is not None and index != existing.index:
                message = (
                    f"Link ({source} {target}) already exists as "
                    f"{existing.index}, cannot also be {index}"
                )
                raise LinkIntegrityError(message)
            return existing
        if index is None:
            link_id = self.allocate_index()
        else:
            if not _is_integer(index) or index < 1:
                message = "Link index must be a positive integer"
                raise LinkIntegrityError(message)
            if index in self.links:
                message = f"Link index {index} is already in use"
                raise LinkIntegrityError(message)
            self.reserve_index(index)
            link_id = index
        link = Link(index=link_id, source=source, target=target)
        self.links[link_id] = link
        self.by_pair[(source, target)] = link_id
        return link

    def update(
        self,
        index: int,
        *,
        source: int,
        target: int,
        new_index: int | None = None,
    ) -> Link:
        """Replace the structure of an existing link, preserving its identity.

        The identity is preserved unless ``new_index`` requests a re-index.
        """
        current = self.links.get(index)
        if current is None:
            message = f"Cannot update missing link {index}"
            raise LinkIntegrityError(message)
        link_id = index if new_index is None else new_index
        collision = self.find_by_pair(source, target)
        if collision is not None and collision.index != index:
            message = (
                f"Cannot update link {index}: ({source} {target}) already "
                f"exists as {collision.index}"
            )
            raise LinkIntegrityError(message)
        if link_id != index and link_id in self.links:
            message = f"Link index {link_id} is already in use"
            raise LinkIntegrityError(message)
        del self.by_pair[(current.source, current.target)]
        del self.links[index]
        link = Link(index=link_id, source=source, target=target)
        self.links[link_id] = link
        self.by_pair[(source, target)] = link_id
        self.reserve_index(link_id)
        return link

    def delete(self, index: int) -> bool:
        """Remove a link by identity; return whether a link was removed."""
        current = self.links.get(index)
        if current is None:
            return False
        del self.by_pair[(current.source, current.target)]
        del self.links[index]
        return True

    def clear(self) -> None:
        """Remove every link and reset identity allocation."""
        self.links.clear()
        self.by_pair.clear()
        self.next_index = 1
