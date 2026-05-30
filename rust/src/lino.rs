//! Links Notation (LiNo) parser and serializer.
//!
//! LiNo represents associative data as nested links. Every link has the form
//!
//! ```text
//! (index: source target)
//! ```
//!
//! where `index` (the identity) is optional and the values (`source`, `target`,
//! ...) are themselves references or links. The notation is the surface syntax
//! for the LinksQL substitution model.
//!
//! The grammar implemented here is:
//!
//! ```text
//! document  = { value } ;
//! value     = link | reference ;
//! link      = "(" [ value ":" ] { value } ")" ;
//! reference = number | name | variable | wildcard | string ;
//! variable  = "$" name ;
//! wildcard  = "*" ;
//! ```
//!
//! The parser produces a small, explicit AST so the rest of the engine never has
//! to re-tokenize text.

use crate::{Error, Result};

/// A reference: the leaf of the AST.
///
/// Mirrors the JavaScript reference node `{ type: "ref", kind, value }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ref {
    /// A numeric reference (an integer index).
    Number(i64),
    /// A named reference (a human-readable label).
    Name(String),
    /// A variable reference, written `$name`; carries the name without the `$`.
    Variable(String),
    /// The wildcard `*`.
    Wildcard,
}

/// An AST node: either a reference leaf or a (possibly nested) link.
///
/// Mirrors the JavaScript node union of reference nodes and link nodes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
    /// A reference leaf.
    Ref(Ref),
    /// A link. `id` is the optional identity (itself a node, so it may be a
    /// reference or a nested link); `values` is the ordered value list.
    Link {
        /// Optional identity node.
        id: Option<Box<Self>>,
        /// Ordered values.
        values: Vec<Self>,
    },
}

/// A token produced by [`tokenize`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Token {
    /// `(`
    LParen,
    /// `)`
    RParen,
    /// `:`
    Colon,
    /// A reference token (bareword or quoted string).
    Ref(Ref),
}

/// Characters treated as whitespace (token separators, otherwise insignificant):
/// space, tab, newline, carriage return, form feed (`\x0c`), vertical tab
/// (`\x0b`).
const fn is_whitespace(ch: char) -> bool {
    matches!(ch, ' ' | '\t' | '\n' | '\r' | '\u{0c}' | '\u{0b}')
}

/// Characters that terminate a bareword.
const fn is_delimiter(ch: char) -> bool {
    matches!(ch, '(' | ')' | ':' | '"' | '\'')
}

/// Characters that force a name to be quoted on output: whitespace, `(`, `)`,
/// `:`, `"`, `'`.
fn quote_required(name: &str) -> bool {
    name.chars()
        .any(|ch| is_whitespace(ch) || matches!(ch, '(' | ')' | ':' | '"' | '\''))
}

/// Classify a bareword (a run of non-delimiter characters) into a reference
/// token. Numbers become numeric references, `$x` becomes a variable, `*`
/// becomes a wildcard, and everything else becomes a name.
fn classify_word(word: &str) -> Ref {
    if word == "*" {
        return Ref::Wildcard;
    }
    if let Some(rest) = word.strip_prefix('$') {
        return Ref::Variable(rest.to_string());
    }
    if !word.is_empty() && word.bytes().all(|b| b.is_ascii_digit()) {
        // `^[0-9]+$`: parse as an integer index.
        if let Ok(value) = word.parse::<i64>() {
            return Ref::Number(value);
        }
    }
    Ref::Name(word.to_string())
}

/// Split LiNo source text into a flat list of tokens.
///
/// # Examples
///
/// ```
/// use linksql::{tokenize, Token, Ref};
/// let kinds = tokenize("(1: 1 1)").unwrap();
/// assert!(matches!(kinds[0], Token::LParen));
/// assert!(matches!(kinds[2], Token::Colon));
/// assert!(matches!(kinds[5], Token::RParen));
/// ```
pub fn tokenize(input: &str) -> Result<Vec<Token>> {
    // Work over Unicode scalar values so positions match the JavaScript engine,
    // which indexes by UTF-16 code unit for the BMP characters used by LiNo.
    let chars: Vec<char> = input.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        let ch = chars[i];
        if is_whitespace(ch) {
            i += 1;
        } else if ch == '(' {
            tokens.push(Token::LParen);
            i += 1;
        } else if ch == ')' {
            tokens.push(Token::RParen);
            i += 1;
        } else if ch == ':' {
            tokens.push(Token::Colon);
            i += 1;
        } else if ch == '"' || ch == '\'' {
            let (value, next) = read_string(&chars, i)?;
            // A quoted token is ALWAYS a name, even if it looks numeric/`$x`/`*`.
            tokens.push(Token::Ref(Ref::Name(value)));
            i = next;
        } else {
            let start = i;
            let mut word = String::new();
            while i < chars.len() && !is_whitespace(chars[i]) {
                if is_delimiter(chars[i]) {
                    break;
                }
                word.push(chars[i]);
                i += 1;
            }
            // `start` is unused beyond clarity, but kept to mirror the source
            // structure of the JavaScript tokenizer.
            let _ = start;
            tokens.push(Token::Ref(classify_word(&word)));
        }
    }
    Ok(tokens)
}

/// Read a quoted string starting at `start` (which points at the quote).
///
/// Returns the unescaped value and the index just past the closing quote.
fn read_string(chars: &[char], start: usize) -> Result<(String, usize)> {
    let quote = chars[start];
    let mut i = start + 1;
    let mut value = String::new();
    while i < chars.len() && chars[i] != quote {
        if chars[i] == '\\' && i + 1 < chars.len() {
            // Backslash escapes the next character (`\"`→`"`, `\\`→`\`).
            value.push(chars[i + 1]);
            i += 2;
        } else {
            value.push(chars[i]);
            i += 1;
        }
    }
    if i >= chars.len() {
        // Positions are small, but convert fallibly to satisfy the lint and stay
        // safe; an impossibly large position degrades to "no position" (-1).
        let position = i64::try_from(start).unwrap_or(-1);
        return Err(Error::lino_syntax("Unterminated quoted string", position));
    }
    Ok((value, i + 1))
}

/// Internal parser cursor over a token slice.
struct Parser<'a> {
    tokens: &'a [Token],
    index: usize,
}

impl<'a> Parser<'a> {
    const fn new(tokens: &'a [Token]) -> Self {
        Self { tokens, index: 0 }
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.index)
    }

    fn advance(&mut self) -> Option<&Token> {
        let token = self.tokens.get(self.index);
        if token.is_some() {
            self.index += 1;
        }
        token
    }

    /// Parse a single value (a reference or a parenthesized link).
    fn parse_value(&mut self) -> Result<Node> {
        match self.peek() {
            None => Err(Error::lino_syntax("Unexpected end of input", -1)),
            Some(Token::LParen) => self.parse_link(),
            Some(Token::Ref(r)) => {
                let node = Node::Ref(r.clone());
                self.advance();
                Ok(node)
            }
            // `)` or `:` cannot start a value. The JavaScript parser names the
            // token type; we reproduce the same diagnostic shape.
            Some(Token::RParen) => Err(Error::lino_syntax("Unexpected 'rparen'", -1)),
            Some(Token::Colon) => Err(Error::lino_syntax("Unexpected 'colon'", -1)),
        }
    }

    /// Parse a link: `(` `[` value `:` `]` values... `)`.
    fn parse_link(&mut self) -> Result<Node> {
        self.advance(); // consume '('
        if matches!(self.peek(), Some(Token::RParen)) {
            self.advance();
            return Ok(Node::Link {
                id: None,
                values: Vec::new(),
            });
        }
        let first = self.parse_value()?;
        let mut id = None;
        let mut values = Vec::new();
        if matches!(self.peek(), Some(Token::Colon)) {
            self.advance(); // consume ':'
            id = Some(Box::new(first));
        } else {
            values.push(first);
        }
        while let Some(token) = self.peek() {
            if matches!(token, Token::RParen) {
                break;
            }
            values.push(self.parse_value()?);
        }
        if !matches!(self.peek(), Some(Token::RParen)) {
            return Err(Error::lino_syntax("Expected )", -1));
        }
        self.advance(); // consume ')'
        Ok(Node::Link { id, values })
    }
}

/// Parse LiNo source text into an array of top-level AST nodes.
///
/// # Examples
///
/// ```
/// use linksql::{parse, Node, Ref};
/// assert_eq!(parse("1").unwrap(), vec![Node::Ref(Ref::Number(1))]);
/// ```
pub fn parse(input: &str) -> Result<Vec<Node>> {
    let tokens = tokenize(input)?;
    let mut parser = Parser::new(&tokens);
    let mut values = Vec::new();
    while parser.index < parser.tokens.len() {
        values.push(parser.parse_value()?);
    }
    Ok(values)
}

/// Quote a name for output if it contains characters that would otherwise be
/// interpreted as structure, escaping `\` and `"`.
fn quote_name(name: &str) -> String {
    if name.is_empty() || quote_required(name) {
        let escaped = name.replace('\\', "\\\\").replace('"', "\\\"");
        format!("\"{escaped}\"")
    } else {
        name.to_string()
    }
}

/// Serialize a reference node to LiNo text.
fn serialize_ref(r: &Ref) -> String {
    match r {
        Ref::Variable(name) => format!("${name}"),
        Ref::Wildcard => "*".to_string(),
        Ref::Number(value) => value.to_string(),
        Ref::Name(name) => quote_name(name),
    }
}

/// Serialize an AST node (reference or link) back to LiNo text.
///
/// # Examples
///
/// ```
/// use linksql::{parse, serialize};
/// let node = &parse("(name: \"hello world\")").unwrap()[0];
/// assert_eq!(serialize(node), "(name: \"hello world\")");
/// ```
#[must_use]
pub fn serialize(node: &Node) -> String {
    match node {
        Node::Ref(r) => serialize_ref(r),
        Node::Link { id, values } => {
            let body = values.iter().map(serialize).collect::<Vec<_>>().join(" ");
            id.as_ref().map_or_else(
                || format!("({body})"),
                |id_node| {
                    let id = serialize(id_node);
                    if body.is_empty() {
                        format!("({id}:)")
                    } else {
                        format!("({id}: {body})")
                    }
                },
            )
        }
    }
}

/// Serialize an array of top-level nodes to LiNo text, one node per joiner.
///
/// The default joiner used by the library elsewhere is a newline; tests pass a
/// space to compare against the canonical round-trip samples.
#[must_use]
pub fn serialize_all(nodes: &[Node], joiner: &str) -> String {
    nodes.iter().map(serialize).collect::<Vec<_>>().join(joiner)
}
