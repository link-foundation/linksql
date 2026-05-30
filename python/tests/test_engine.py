"""Tests for the store, the substitution engine and the query executor.

Mirrors ``tests/engine.test.js`` from the JavaScript reference implementation.
The CRUD examples mirror the canonical operations from the specification: each
assertion here is a behavioural requirement replicated from that suite.
"""

from __future__ import annotations

import pytest

from linksql.lino import parse
from linksql.names import Names, UnknownNameError
from linksql.query import Database, QueryError, link_to_lino, split_query
from linksql.store import Link, LinkIntegrityError, LinksStore


class TestLinksStore:
    def test_creates_and_deduplicates_by_source_target(self) -> None:
        store = LinksStore()
        a = store.create(source=1, target=1)
        b = store.create(source=1, target=1)
        assert a.index == b.index
        assert store.size == 1

    def test_allocates_fresh_identities_that_skip_used_ones(self) -> None:
        store = LinksStore()
        store.create(index=1, source=1, target=1)
        nxt = store.create(source=2, target=3)
        assert nxt.index == 2

    def test_rejects_conflicting_explicit_identities(self) -> None:
        store = LinksStore()
        store.create(index=5, source=1, target=2)
        with pytest.raises(LinkIntegrityError):
            store.create(index=6, source=1, target=2)

    def test_updates_structure_while_keeping_identity(self) -> None:
        store = LinksStore()
        link = store.create(source=1, target=1)
        updated = store.update(link.index, source=1, target=2)
        assert updated.index == link.index
        assert updated.target == 2
        assert store.find_by_pair(1, 1) is None

    def test_throws_on_integrity_violations(self) -> None:
        store = LinksStore()
        with pytest.raises(LinkIntegrityError):
            store.update(99, source=1, target=1)


class TestDatabaseCrud:
    def test_create_makes_a_point(self) -> None:
        db = Database()
        report = db.query("() ((1 1))")
        assert report.operation == "create"
        assert report.created == [Link(index=1, source=1, target=1)]
        assert db.count() == 1

    def test_read_lone_restriction_returns_matches_without_mutating(self) -> None:
        db = Database()
        db.query("() ((1 1))")
        report = db.query("((1: 1 1))")
        assert report.operation == "read"
        assert len(report.matched) == 1
        assert report.matched[0].links[0] == Link(index=1, source=1, target=1)
        assert report.created == []
        assert report.updated == []
        assert report.deleted == []

    def test_read_variables_bind_to_every_link(self) -> None:
        db = Database()
        db.query("() ((1 1))")
        db.query("() ((1 2))")
        report = db.query("(($i: $s $t))")
        assert report.operation == "read"
        assert len(report.matched) == 2
        bindings = [row.binding for row in report.matched]
        assert bindings == [
            {"i": 1, "s": 1, "t": 1},
            {"i": 2, "s": 1, "t": 2},
        ]

    def test_update_rewrites_in_place(self) -> None:
        db = Database()
        db.query("() ((1 1))")
        report = db.query("((1: 1 1)) ((1: 1 2))")
        assert report.operation == "update"
        assert report.updated == [Link(index=1, source=1, target=2)]
        assert db.count() == 1

    def test_delete_removes_the_match(self) -> None:
        db = Database()
        db.query("() ((1 2))")
        report = db.query("((1 2)) ()")
        assert report.operation == "delete"
        assert report.deleted == [Link(index=1, source=1, target=2)]
        assert db.count() == 0

    def test_non_matching_restriction_makes_no_changes(self) -> None:
        db = Database()
        db.query("() ((1 1))")
        report = db.query("((9: 9 9)) ((9: 9 8))")
        assert report.operation == "noop"
        assert db.count() == 1


class TestConjunctiveJoin:
    def test_composes_edges_by_sharing_a_variable(self) -> None:
        db = Database()
        # Edges 1->2 and 2->3 (identities allocated automatically).
        db.query("() ((1 2))")
        db.query("() ((2 3))")
        # Match a 2-hop path: ($x -> $y) and ($y -> $z).
        report = db.query("(($x $y) ($y $z))")
        assert report.operation == "read"
        assert len(report.matched) == 1
        assert report.matched[0].binding == {"x": 1, "y": 2, "z": 3}


class TestNamedReferences:
    def test_auto_creates_names_as_points_and_links_them(self) -> None:
        db = Database()
        report = db.query("() ((alice bob))")
        assert report.operation == "create"
        # alice and bob become points; the relation links them.
        assert db.count() == 3
        alice = db.names.resolve("alice")
        bob = db.names.resolve("bob")
        assert alice is not None
        assert bob is not None
        assert db.store.find_by_pair(alice, bob) is not None

    def test_honours_auto_create_false(self) -> None:
        names = Names(LinksStore(), auto_create=False)
        with pytest.raises(UnknownNameError):
            names.ensure("ghost")


class TestSplitQuery:
    def test_treats_one_node_as_a_read(self) -> None:
        split = split_query(parse("((1: 1 1))"))
        assert split.substitution is None

    def test_treats_two_nodes_as_restriction_plus_substitution(self) -> None:
        split = split_query(parse("((1 1)) ((1 2))"))
        assert len(split.restriction) == 1
        assert split.substitution is not None
        assert len(split.substitution) == 1

    def test_rejects_more_than_two_top_level_nodes(self) -> None:
        with pytest.raises(QueryError):
            split_query(parse("(1) (2) (3)"))


class TestSerialisationAndIntrospection:
    def test_serialises_links_to_canonical_lino(self) -> None:
        assert link_to_lino(Link(index=3, source=1, target=2)) == "(3: 1 2)"

    def test_round_trips_the_whole_database_through_lino(self) -> None:
        db = Database()
        db.query("() ((1 1))")
        db.query("() ((1 2))")
        text = db.to_lino()
        restored = Database()
        restored.import_lino(text)
        assert restored.to_lino() == text

    def test_introspects_link_count_and_names(self) -> None:
        db = Database()
        db.query("() ((alice bob))")
        info = db.introspect()
        assert info.link_count == 3
        assert "alice" in [entry["name"] for entry in info.names]
