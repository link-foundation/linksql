"""Tests for the Links Notation (LiNo) parser and serializer.

Mirrors ``tests/lino.test.js`` from the JavaScript reference implementation: each
assertion here is a behavioural requirement replicated from that suite.
"""

from __future__ import annotations

import pytest

from linksql.lino import (
    Link,
    LinoSyntaxError,
    Ref,
    parse,
    serialize,
    serialize_all,
    tokenize,
)


class TestTokenize:
    def test_splits_structure_and_words(self) -> None:
        kinds = [token.type for token in tokenize("(1: 1 1)")]
        assert kinds == ["lparen", "ref", "colon", "ref", "ref", "rparen"]

    def test_reads_quoted_strings_with_escapes(self) -> None:
        tokens = tokenize('"a\\"b"')
        assert len(tokens) == 1
        assert tokens[0].value == 'a"b'


class TestParse:
    def test_classifies_references(self) -> None:
        assert parse("1")[0] == Ref(kind="number", value=1)
        assert parse("$x")[0] == Ref(kind="variable", value="x")
        assert parse("*")[0] == Ref(kind="wildcard", value="*")
        assert parse("alice")[0] == Ref(kind="name", value="alice")

    def test_parses_a_link_with_an_explicit_identity(self) -> None:
        node = parse("(1: 1 1)")[0]
        assert isinstance(node, Link)
        assert node.id == Ref(kind="number", value=1)
        assert len(node.values) == 2

    def test_parses_the_empty_link(self) -> None:
        assert parse("()")[0] == Link(id=None, values=[])

    def test_parses_a_two_value_query_into_two_top_level_nodes(self) -> None:
        nodes = parse("() ((1 1))")
        assert len(nodes) == 2
        node0, node1 = nodes
        assert isinstance(node0, Link)
        assert isinstance(node1, Link)
        assert len(node0.values) == 0
        assert len(node1.values) == 1

    def test_parses_nested_links(self) -> None:
        node = parse("((1 2) (3 4))")[0]
        assert isinstance(node, Link)
        assert isinstance(node.values[0], Link)
        assert isinstance(node.values[1], Link)

    def test_rejects_non_string_input(self) -> None:
        with pytest.raises(LinoSyntaxError):
            parse(42)  # type: ignore[arg-type]

    def test_rejects_unterminated_strings(self) -> None:
        with pytest.raises(LinoSyntaxError):
            parse('"abc')

    def test_rejects_unbalanced_parentheses(self) -> None:
        with pytest.raises(LinoSyntaxError):
            parse("(1 2")

    def test_reports_a_lino_syntax_error_instance(self) -> None:
        caught: Exception | None = None
        try:
            parse("(1 2")
        except LinoSyntaxError as error:
            caught = error
        assert isinstance(caught, LinoSyntaxError)


SAMPLES = [
    "1",
    "(1: 1 1)",
    "() ((1 1))",
    "((1: 1 1)) ((1: 1 2))",
    "((1 2)) ()",
    "((($i: $s $t)) (($i: $s $t)))",
    "(parent (child grandchild))",
]


class TestSerializeRoundTrips:
    @pytest.mark.parametrize("sample", SAMPLES)
    def test_round_trips(self, sample: str) -> None:
        nodes = parse(sample)
        text = serialize_all(nodes, " ")
        assert text == sample
        # Re-parsing the output yields the same AST.
        assert parse(text) == nodes

    def test_quotes_names_that_contain_structure_characters(self) -> None:
        node = parse('(name: "hello world")')[0]
        assert serialize(node) == '(name: "hello world")'
