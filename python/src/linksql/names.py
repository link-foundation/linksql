"""Named references.

Link indices are convenient for machines but opaque to humans. A :class:`Names`
registry maps human-readable labels to link identities (mirroring the sidecar
``<db>.names.links`` file used by link-cli) so a query can say
``(alice loves bob)`` instead of ``(7 9 8)``.

A freshly-named identity is materialised as a *point* — the link ``(i: i i)`` —
so that everything in the model remains a link. When ``auto_create`` is disabled,
referring to an unknown name is an error instead, which is useful for catching
typos in production schemas.

This module is a faithful, behaviourally-identical port of ``src/names.js`` from
the JavaScript reference implementation.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .store import LinksStore


class UnknownNameError(Exception):
    """Error raised when an unknown name is used while auto-creation is off."""

    def __init__(self, name: str) -> None:
        super().__init__(f"Unknown named reference: {name}")
        self.name = name


class Names:
    """A bidirectional registry of label <-> link-index associations."""

    def __init__(self, store: LinksStore, *, auto_create: bool = True) -> None:
        self.store = store
        self.auto_create = auto_create
        self.by_name: dict[str, int] = {}
        self.by_index: dict[int, str] = {}

    def resolve(self, name: str) -> int | None:
        """Resolve a name to its index without creating anything."""
        return self.by_name.get(name)

    def ensure(self, name: str) -> int:
        """Resolve a name, allocating and materialising it when permitted."""
        existing = self.by_name.get(name)
        if existing is not None:
            return existing
        if not self.auto_create:
            raise UnknownNameError(name)
        index = self.store.allocate_index()
        self.bind(name, index)
        if not self.store.has(index):
            self.store.create(index=index, source=index, target=index)
        return index

    def bind(self, name: str, index: int) -> int:
        """Associate a name with an existing index (no materialisation)."""
        self.by_name[name] = index
        self.by_index[index] = name
        self.store.reserve_index(index)
        return index

    def name_of(self, index: int) -> str | None:
        """Look up the label associated with an index."""
        return self.by_index.get(index)

    def entries(self) -> list[tuple[str, int]]:
        """Return all ``[name, index]`` associations in insertion order."""
        return list(self.by_name.items())
