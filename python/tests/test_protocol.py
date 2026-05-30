"""Tests for the Links Notation wire protocol.

Links Notation — not JSON — is the data transfer format. These tests pin the
round-trip behaviour of :func:`encode`/:func:`decode` (including the exact report
shape the engine produces) and the content negotiation that lets a caller opt
into the JSON projection. They mirror ``js/tests/protocol.test.js`` so every
language port speaks the same dialect.
"""

from __future__ import annotations

from linksql.protocol import (
    LINO_CONTENT_TYPE,
    decode,
    encode,
    prefers_json,
)
from linksql.query import Database, MatchRow, QueryReport
from linksql.store import Link


class TestLinksNotationProtocol:
    def test_encodes_a_query_report_to_links_notation(self) -> None:
        report = QueryReport(
            operation="update",
            matched=[
                MatchRow(
                    links=[Link(index=1, source=1, target=1)],
                    binding={"s": 1, "t": 2},
                )
            ],
            created=[],
            updated=[Link(index=3, source=1, target=4)],
            deleted=[],
        )
        assert encode(report) == (
            "((operation update) (matched (((links (((index 1) (source 1) "
            "(target 1)))) (binding ((s 1) (t 2)))))) (created ()) (updated "
            "(((index 3) (source 1) (target 4)))) (deleted ()))"
        )

    def test_round_trips_an_arbitrary_report(self) -> None:
        report = {
            "operation": "create",
            "matched": [],
            "created": [{"index": 1, "source": 1, "target": 1}],
            "updated": [],
            "deleted": [],
        }
        assert decode(encode(report)) == report

    def test_encodes_an_empty_object_as_empty_link(self) -> None:
        assert encode({}) == "()"

    def test_prefers_links_notation_unless_json_requested(self) -> None:
        assert prefers_json(None) is False
        assert prefers_json(LINO_CONTENT_TYPE) is False
        assert prefers_json("text/plain") is False
        assert prefers_json("application/json") is True
        assert prefers_json("text/json") is True
        # Links Notation wins when both are present.
        assert prefers_json(f"{LINO_CONTENT_TYPE}, application/json") is False

    def test_encodes_a_real_query_report(self) -> None:
        db = Database()
        report = db.query("() ((1 1))")
        decoded = decode(encode(report))
        assert decoded["operation"] == "create"
        assert decoded["created"] == [{"index": 1, "source": 1, "target": 1}]
