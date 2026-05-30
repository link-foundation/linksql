"""LinksQL wire protocol — Links Notation as the data transfer format.

The issue (and the PR review) is explicit: Links Notation, not JSON, is the
actual data protocol. Every structured value that crosses the network — query
reports, link lists, introspection snapshots — travels as Links Notation text.
Inside a process we still work with plain Python values (dataclasses, dicts,
lists, scalars), so this module is the single boundary that converts between the
two::

    value   --encode-->  "((operation update) (created ()) ...)"
    "(...)"  --decode-->  value

This is a faithful, behaviourally-identical port of the ``lino-objects-codec``
convention used by the JavaScript reference implementation (see ``js/src``):

- an object becomes a link of key/value pairs: ``((key value) (key value) ...)``
- an array becomes a link of its elements: ``(a b c)``
- an empty object or array becomes ``()``
- ``None`` becomes ``null``; numbers and booleans become their literal text
- strings are escaped only when they contain whitespace, quotes, parentheses,
  colons or newlines

Decoding reuses the engine's own LiNo parser (:mod:`linksql.lino`) and then
applies the codec's "all-pairs means object, otherwise array" rule.
"""

from __future__ import annotations

import dataclasses
import re

from .lino import Link as LinkNode
from .lino import Node, Ref, parse

# The canonical content type for Links Notation payloads.
LINO_CONTENT_TYPE = "application/lino"
# The opt-in content type for the JSON projection of a payload.
JSON_CONTENT_TYPE = "application/json"

# A reference needs escaping when it contains whitespace, quotes, parentheses,
# or a colon (mirrors the codec's ``/[\s()'":]/`` test plus an explicit newline).
_NEEDS_ESCAPING = re.compile(r"[\s()'\":]")


def escape_reference(value: object) -> str:  # noqa: PLR0911
    """Escape a scalar value for use as a Links Notation reference.

    Faithful port of ``escapeReference`` from ``lino-objects-codec``: numbers and
    booleans pass through, and strings are wrapped only when they contain
    structure-significant characters, preferring whichever quote minimises
    internal escaping.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _number_to_text(value)

    text = str(value)
    if not (_NEEDS_ESCAPING.search(text) or "\n" in text):
        return text

    has_single = "'" in text
    has_double = '"' in text
    if has_single and not has_double:
        return f'"{text}"'
    if has_double and not has_single:
        return f"'{text}'"
    if has_single and has_double:
        single_count = text.count("'")
        double_count = text.count('"')
        if double_count < single_count:
            return '"' + text.replace('"', '""') + '"'
        return "'" + text.replace("'", "''") + "'"
    # Just spaces or other special characters: single-quote by default.
    return f"'{text}'"


def _number_to_text(value: float) -> str:
    """Render a number the way JavaScript's ``String(value)`` would.

    Integers (and integer-valued floats) print without a trailing ``.0`` so the
    encoding matches the JavaScript reference byte-for-byte.
    """
    if isinstance(value, bool):  # defensive; bool handled by callers first
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if value.is_integer():
        return str(int(value))
    return repr(value)


def _to_jsonable(value: object) -> object:
    """Project dataclasses (and nested ones) onto plain dict/list/scalar values.

    ``encode`` accepts the engine's report dataclasses directly; this keeps the
    conversion boundary in one place while preserving field order.
    """
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {
            field.name: _to_jsonable(getattr(value, field.name))
            for field in dataclasses.fields(value)
        }
    if isinstance(value, dict):
        return {key: _to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(item) for item in value]
    return value


def encode(value: object) -> str:
    """Encode a Python value (or report dataclass) as Links Notation text."""
    return _encode_jsonable(_to_jsonable(value))


def _encode_jsonable(value: object) -> str:  # noqa: PLR0911
    """Encode an already-projected JSON-shaped value as Links Notation."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _number_to_text(value)
    if isinstance(value, str):
        return escape_reference(value)
    if isinstance(value, list):
        if not value:
            return "()"
        return "(" + " ".join(_encode_jsonable(item) for item in value) + ")"
    if isinstance(value, dict):
        if not value:
            return "()"
        pairs = [
            f"({escape_reference(key)} {_encode_jsonable(item)})"
            for key, item in value.items()
        ]
        return "(" + " ".join(pairs) + ")"
    # Fallback for unknown types, matching the codec.
    return escape_reference(str(value))


def _parse_reference(ref: Ref) -> object:
    """Parse a reference node into its primitive value (true/false/null/num/str)."""
    if ref.kind == "number":
        return ref.value
    text = str(ref.value)
    if text == "true":
        return True
    if text == "false":
        return False
    if text == "null":
        return None
    if text.strip() != "":
        try:
            number = float(text)
        except ValueError:
            number = None
        if number is not None:
            return int(number) if number.is_integer() else number
    return text


def _is_pair(child: Node) -> bool:
    """Whether a node is a key/value pair with a string-like key (object entry)."""
    if not isinstance(child, LinkNode) or len(child.values) != 2:
        return False
    key = child.values[0]
    if not isinstance(key, Ref):
        return False
    key_value = _parse_reference(key)
    return not isinstance(key_value, (int, float))


def _convert(node: Node) -> object:
    """Convert a parsed LiNo node into a JSON-shaped value (codec semantics)."""
    if isinstance(node, Ref):
        return _parse_reference(node)
    # A link with no values is either the empty link () -> [] or a lone reference.
    if not node.values:
        if node.id is None:
            return []
        return (
            _parse_reference(node.id) if isinstance(node.id, Ref) else _convert(node.id)
        )
    # All children are key/value pairs -> object; otherwise an array.
    if all(_is_pair(child) for child in node.values):
        result: dict[str, object] = {}
        for child in node.values:
            assert isinstance(child, LinkNode)
            key = _parse_reference(child.values[0])  # type: ignore[arg-type]
            result[str(key)] = _convert(child.values[1])
        return result
    return [_convert(value) for value in node.values]


def decode(lino: str) -> object:
    """Decode Links Notation text back into a JSON-shaped Python value."""
    if not isinstance(lino, str) or not lino:
        return None
    nodes = parse(lino)
    if not nodes:
        return None
    result = _convert(nodes[0])
    # Unwrap a single primitive the parser wrapped in a one-element list.
    if (
        isinstance(result, list)
        and len(result) == 1
        and isinstance(result[0], (str, int, float, bool, type(None)))
    ):
        return result[0]
    return result


def prefers_json(header: str | None) -> bool:
    """Whether a caller's ``Accept``/``Content-Type`` header opts into JSON.

    Links Notation is always the default; JSON is only used when a client asks
    for it explicitly, and Links Notation wins when both are present.
    """
    if not header:
        return False
    lower = header.lower()
    if LINO_CONTENT_TYPE in lower:
        return False
    return "application/json" in lower or "text/json" in lower
