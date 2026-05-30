"""Links Notation (LiNo) parser and serializer.

LiNo represents associative data as nested links. Every link has the form::

    (index: source target)

where ``index`` (the identity) is optional and the values (``source``,
``target``, ...) are themselves references or links. The notation is the surface
syntax for the LinksQL substitution model.

The grammar implemented here is::

    document  = { value } ;
    value     = link | reference ;
    link      = "(" [ value ":" ] { value } ")" ;
    reference = number | name | variable | wildcard | string ;
    variable  = "$" name ;
    wildcard  = "*" ;

The parser produces a small, explicit AST so the rest of the engine never has to
re-tokenize text.

This module is a faithful, behaviourally-identical port of ``src/lino.js`` from
the JavaScript reference implementation.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Union


class LinoSyntaxError(Exception):
    """Error raised when LiNo input cannot be parsed.

    Mirrors the JavaScript ``LinoSyntaxError``: the formatted message appends a
    position suffix only when ``position`` is non-negative, and ``position``
    stays available as an attribute.
    """

    def __init__(self, message: str, position: int) -> None:
        full = f"{message} (at position {position})" if position >= 0 else message
        super().__init__(full)
        self.position = position


# Whitespace characters that separate tokens (otherwise insignificant).
_WHITESPACE = frozenset((" ", "\t", "\n", "\r", "\f", "\v"))
# Structural delimiters that break a bareword and/or carry their own meaning.
_DELIMITERS = frozenset(("(", ")", ":", '"', "'"))
# Characters that force a name to be quoted on output.
_QUOTE_REQUIRED = re.compile(r"[\s():\"']")
# A bareword that is entirely ASCII digits is a numeric reference.
_DIGITS = re.compile(r"^\d+$")


@dataclass(frozen=True)
class Ref:
    """A reference node: a number, name, variable, or wildcard.

    ``kind`` is one of ``"number"``, ``"name"``, ``"variable"``, ``"wildcard"``.
    For ``"number"`` references ``value`` is an :class:`int`; otherwise it is the
    string label / variable name / ``"*"``.
    """

    kind: str
    value: int | str


@dataclass
class Link:
    """A link node: ``( [ id ":" ] values... )``.

    ``id`` is a reference node, a nested link node, or ``None`` (absent) and
    ``values`` is an ordered list of child nodes.
    """

    id: Node | None
    values: list[Node]


# A LiNo AST node is either a reference or a link.
Node = Union[Ref, Link]


@dataclass(frozen=True)
class Token:
    """A LiNo token.

    ``type`` is one of ``"lparen"``, ``"rparen"``, ``"colon"``, ``"ref"``. For
    ``"ref"`` tokens ``kind`` classifies the reference and ``value`` carries its
    payload; ``pos`` is the source offset and ``quoted`` records whether the ref
    came from a quoted string.
    """

    type: str
    pos: int
    kind: str | None = None
    value: int | str | None = None
    quoted: bool = field(default=False)


def _classify_word(word: str, pos: int) -> Token:
    """Classify a bareword into a reference token.

    Numbers become numeric references, ``$x`` becomes a variable, ``*`` becomes a
    wildcard, and everything else becomes a name.
    """
    if word == "*":
        return Token(type="ref", kind="wildcard", value="*", pos=pos)
    if word[:1] == "$":
        return Token(type="ref", kind="variable", value=word[1:], pos=pos)
    if _DIGITS.match(word):
        return Token(type="ref", kind="number", value=int(word), pos=pos)
    return Token(type="ref", kind="name", value=word, pos=pos)


def _read_string(text: str, start: int) -> tuple[Token, int]:
    """Read a quoted string starting at ``start`` (which points at the quote).

    Returns the resulting name token and the index just past the closing quote.
    """
    quote = text[start]
    i = start + 1
    chars: list[str] = []
    n = len(text)
    while i < n and text[i] != quote:
        if text[i] == "\\" and i + 1 < n:
            chars.append(text[i + 1])
            i += 2
        else:
            chars.append(text[i])
            i += 1
    if i >= n:
        message = "Unterminated quoted string"
        raise LinoSyntaxError(message, start)
    token = Token(type="ref", kind="name", value="".join(chars), pos=start, quoted=True)
    return token, i + 1


def tokenize(text: str) -> list[Token]:
    """Split LiNo source text into a flat list of tokens."""
    tokens: list[Token] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch in _WHITESPACE:
            i += 1
        elif ch == "(":
            tokens.append(Token(type="lparen", pos=i))
            i += 1
        elif ch == ")":
            tokens.append(Token(type="rparen", pos=i))
            i += 1
        elif ch == ":":
            tokens.append(Token(type="colon", pos=i))
            i += 1
        elif ch in ('"', "'"):
            token, nxt = _read_string(text, i)
            tokens.append(token)
            i = nxt
        else:
            start = i
            chars: list[str] = []
            while i < n and text[i] not in _WHITESPACE:
                if text[i] in _DELIMITERS:
                    break
                chars.append(text[i])
                i += 1
            tokens.append(_classify_word("".join(chars), start))
    return tokens


@dataclass
class _Cursor:
    """A parser cursor over a flat token list."""

    tokens: list[Token]
    index: int = 0

    def peek(self) -> Token | None:
        if self.index < len(self.tokens):
            return self.tokens[self.index]
        return None

    def advance(self) -> Token:
        token = self.tokens[self.index]
        self.index += 1
        return token


def _reference_node(token: Token) -> Ref:
    """Build a reference AST node from a reference token."""
    assert token.kind is not None
    assert token.value is not None
    return Ref(kind=token.kind, value=token.value)


def _parse_value(cursor: _Cursor) -> Node:
    """Parse a single value (a reference or a parenthesized link)."""
    token = cursor.peek()
    if token is None:
        message = "Unexpected end of input"
        raise LinoSyntaxError(message, -1)
    if token.type == "lparen":
        return _parse_link(cursor)
    if token.type == "ref":
        cursor.advance()
        return _reference_node(token)
    message = f"Unexpected '{token.type}'"
    raise LinoSyntaxError(message, token.pos)


def _parse_link(cursor: _Cursor) -> Link:
    """Parse a link: ``(`` [ value ``:`` ] values... ``)``."""
    cursor.advance()  # consume '('
    nxt = cursor.peek()
    if nxt is not None and nxt.type == "rparen":
        cursor.advance()
        return Link(id=None, values=[])
    first = _parse_value(cursor)
    link_id: Node | None = None
    values: list[Node] = []
    nxt = cursor.peek()
    if nxt is not None and nxt.type == "colon":
        cursor.advance()  # consume ':'
        link_id = first
    else:
        values.append(first)
    while True:
        nxt = cursor.peek()
        if nxt is None or nxt.type == "rparen":
            break
        values.append(_parse_value(cursor))
    closing = cursor.peek()
    if closing is None or closing.type != "rparen":
        message = "Expected )"
        raise LinoSyntaxError(message, closing.pos if closing is not None else -1)
    cursor.advance()  # consume ')'
    return Link(id=link_id, values=values)


def parse(text: str) -> list[Node]:
    """Parse LiNo source text into a list of top-level AST nodes."""
    if not isinstance(text, str):
        message = "LiNo input must be a string"
        raise LinoSyntaxError(message, -1)
    cursor = _Cursor(tokens=tokenize(text))
    values: list[Node] = []
    while cursor.index < len(cursor.tokens):
        values.append(_parse_value(cursor))
    return values


def _quote_name(name: str) -> str:
    """Quote a name for output if it contains structure-significant characters."""
    if name == "" or _QUOTE_REQUIRED.search(name):
        escaped = name.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{escaped}"'
    return name


def _serialize_ref(node: Ref) -> str:
    """Serialize a reference node to LiNo text."""
    if node.kind == "variable":
        return f"${node.value}"
    if node.kind == "wildcard":
        return "*"
    if node.kind == "number":
        return str(node.value)
    return _quote_name(str(node.value))


def serialize(node: Node) -> str:
    """Serialize an AST node (reference or link) back to LiNo text."""
    if isinstance(node, Ref):
        return _serialize_ref(node)
    body = " ".join(serialize(value) for value in node.values)
    if node.id is not None:
        link_id = serialize(node.id)
        return f"({link_id}: {body})" if body else f"({link_id}:)"
    return f"({body})"


def serialize_all(nodes: list[Node], joiner: str = "\n") -> str:
    """Serialize a list of top-level nodes to LiNo text, joined by ``joiner``."""
    return joiner.join(serialize(node) for node in nodes)
