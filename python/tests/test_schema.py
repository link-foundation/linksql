"""Tests for the GraphQL-class schema layer.

These pin the data model of a schema written in Links Notation: parsing types,
relations, named queries and subscriptions; inferring scalar types from relation
endpoints; the lookups and validation around them; the introspection document;
and the round-trip back through Links Notation. They mirror the non-networked
parts of ``js/tests/schema.test.js`` (the Python port is engine-only, so the
server-generation tests have no analogue here).
"""

from __future__ import annotations

import pytest

from linksql.schema import Schema, SchemaError

SCHEMA_TEXT = """(schema social
  (type Person)
  (type Post)
  (relation name (from Person) (to Text))
  (relation author (from Post) (to Person))
  (relation likes (from Person) (to Post))
  (query everyone (($p: $p $p)))
  (subscription newLikes ((1 $post))))"""


class TestSchema:
    def test_parses_types_relations_queries_and_subscriptions(self) -> None:
        schema = Schema.parse(SCHEMA_TEXT)
        assert schema.name == "social"
        assert schema.types == ["Person", "Post"]
        assert len(schema.relations) == 3
        author = schema.relation("author")
        assert author is not None
        assert author.source == "Post"
        assert author.target == "Person"
        everyone = schema.query("everyone")
        assert everyone is not None
        assert everyone.text == "(($p: $p $p))"
        new_likes = schema.subscription("newLikes")
        assert new_likes is not None
        assert new_likes.pattern == "((1 $post))"

    def test_infers_scalar_types_from_relation_endpoints(self) -> None:
        schema = Schema.parse(SCHEMA_TEXT)
        # `Text` is referenced but never declared as a type, so it is a scalar.
        assert schema.scalars == ["Text"]
        assert schema.knows("Person") is True
        assert schema.knows("Text") is True
        assert schema.knows("likes") is True
        assert schema.knows("missing") is False

    def test_produces_an_introspection_document(self) -> None:
        doc = Schema.parse(SCHEMA_TEXT).introspect()
        assert doc["name"] == "social"
        assert doc["types"] == ["Person", "Post"]
        relations = doc["relations"]
        assert isinstance(relations, list)
        assert [r["name"] for r in relations] == ["name", "author", "likes"]
        assert relations[1] == {"name": "author", "from": "Post", "to": "Person"}
        queries = doc["queries"]
        assert isinstance(queries, list)
        assert [q["name"] for q in queries] == ["everyone"]
        subscriptions = doc["subscriptions"]
        assert isinstance(subscriptions, list)
        assert [s["name"] for s in subscriptions] == ["newLikes"]

    def test_round_trips_through_links_notation(self) -> None:
        schema = Schema.parse(SCHEMA_TEXT)
        reparsed = Schema.parse(schema.to_lino())
        assert reparsed.introspect() == schema.introspect()

    def test_validates_relations(self) -> None:
        schema = Schema.parse(SCHEMA_TEXT)
        assert schema.validate_relation("likes").name == "likes"
        with pytest.raises(SchemaError):
            schema.validate_relation("missing")

    def test_rejects_a_schema_that_is_not_a_schema_link(self) -> None:
        with pytest.raises(SchemaError):
            Schema.parse("(person)")

    def test_rejects_a_relation_missing_an_endpoint(self) -> None:
        with pytest.raises(SchemaError):
            Schema.parse("(schema (relation r (from A)))")

    def test_rejects_an_unknown_declaration_keyword(self) -> None:
        with pytest.raises(SchemaError):
            Schema.parse("(schema (mutate x))")
