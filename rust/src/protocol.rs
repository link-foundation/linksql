//! LinksQL wire protocol — Links Notation as the data transfer format.
//!
//! The issue (and the PR review) is explicit: Links Notation, not JSON, is the
//! actual data protocol. Every structured value that crosses the network — query
//! reports, link lists, introspection snapshots — travels as Links Notation
//! text. Inside a process we work with typed values ([`QueryReport`], [`Link`]),
//! so this module is the single boundary that converts between the two through a
//! generic [`Value`] tree:
//!
//! ```text
//! value   --encode-->  "((operation update) (created ()) ...)"
//! "(...)"  --decode-->  value
//! ```
//!
//! This is a faithful, behaviourally-identical port of the `lino-objects-codec`
//! convention used by the JavaScript reference implementation (see `js/src`):
//!
//! - an object becomes a link of key/value pairs: `((key value) (key value) ...)`
//! - an array becomes a link of its elements: `(a b c)`
//! - an empty object or array becomes `()`
//! - `null` becomes `null`; numbers and booleans become their literal text
//! - strings are escaped only when they contain whitespace, quotes, parentheses,
//!   colons or newlines

use crate::lino::{parse, Node, Ref};
use crate::query::{Introspection, MatchRow, QueryReport};
use crate::store::Link;
use crate::Result;

/// The canonical content type for Links Notation payloads.
pub const LINO_CONTENT_TYPE: &str = "application/lino";
/// The opt-in content type for the JSON projection of a payload.
pub const JSON_CONTENT_TYPE: &str = "application/json";

/// A generic, JSON-shaped value — the lingua franca between typed engine
/// structures and Links Notation text.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    /// The null value.
    Null,
    /// A boolean.
    Bool(bool),
    /// An integer.
    Int(i64),
    /// A floating-point number.
    Float(f64),
    /// A string.
    Str(String),
    /// An ordered array.
    Array(Vec<Self>),
    /// An object as ordered key/value pairs (insertion order is significant).
    Object(Vec<(String, Self)>),
}

/// Whether a string needs escaping: it contains whitespace, a quote, a
/// parenthesis, a colon, or a newline (mirrors the codec's `/[\s()'":]/`).
fn needs_escaping(text: &str) -> bool {
    text.chars()
        .any(|ch| ch.is_whitespace() || matches!(ch, '(' | ')' | '\'' | '"' | ':'))
}

/// Escape a string for use as a Links Notation reference, preferring whichever
/// quote minimises internal escaping. Faithful port of `escapeReference`.
fn escape_reference(text: &str) -> String {
    if !needs_escaping(text) {
        return text.to_string();
    }
    let has_single = text.contains('\'');
    let has_double = text.contains('"');
    if has_single && !has_double {
        return format!("\"{text}\"");
    }
    if has_double && !has_single {
        return format!("'{text}'");
    }
    if has_single && has_double {
        let single_count = text.matches('\'').count();
        let double_count = text.matches('"').count();
        if double_count < single_count {
            return format!("\"{}\"", text.replace('"', "\"\""));
        }
        return format!("'{}'", text.replace('\'', "''"));
    }
    // Just spaces or other special characters: single-quote by default.
    format!("'{text}'")
}

/// Render a float the way JavaScript's `String(value)` would: integer-valued
/// floats print without a trailing `.0`.
fn float_to_text(value: f64) -> String {
    if value.fract() == 0.0 && value.is_finite() {
        // Integer-valued and finite: `{:.0}` is exact (no rounding) and avoids a
        // lossy `as i64` cast.
        format!("{value:.0}")
    } else {
        format!("{value}")
    }
}

/// Encode a [`Value`] as Links Notation text.
#[must_use]
pub fn encode(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(boolean) => boolean.to_string(),
        Value::Int(number) => number.to_string(),
        Value::Float(number) => float_to_text(*number),
        Value::Str(text) => escape_reference(text),
        Value::Array(items) => {
            if items.is_empty() {
                "()".to_string()
            } else {
                let parts: Vec<String> = items.iter().map(encode).collect();
                format!("({})", parts.join(" "))
            }
        }
        Value::Object(pairs) => {
            if pairs.is_empty() {
                "()".to_string()
            } else {
                let parts: Vec<String> = pairs
                    .iter()
                    .map(|(key, item)| format!("({} {})", escape_reference(key), encode(item)))
                    .collect();
                format!("({})", parts.join(" "))
            }
        }
    }
}

/// Parse a reference's text into a primitive value (true/false/null/number/str).
fn parse_reference(text: &str) -> Value {
    match text {
        "true" => return Value::Bool(true),
        "false" => return Value::Bool(false),
        "null" => return Value::Null,
        _ => {}
    }
    if !text.trim().is_empty() {
        if let Ok(integer) = text.parse::<i64>() {
            return Value::Int(integer);
        }
        if let Ok(float) = text.parse::<f64>() {
            return Value::Float(float);
        }
    }
    Value::Str(text.to_string())
}

/// Convert a reference node into a primitive value.
fn reference_value(reference: &Ref) -> Value {
    match reference {
        Ref::Number(number) => Value::Int(*number),
        Ref::Name(name) => parse_reference(name),
        Ref::Variable(name) => Value::Str(format!("${name}")),
        Ref::Wildcard => Value::Str("*".to_string()),
    }
}

/// Whether a node is a key/value pair with a string-like key (an object entry).
fn is_pair(node: &Node) -> bool {
    let Node::Link { values, .. } = node else {
        return false;
    };
    if values.len() != 2 {
        return false;
    }
    match &values[0] {
        Node::Ref(reference) => {
            !matches!(reference_value(reference), Value::Int(_) | Value::Float(_))
        }
        Node::Link { .. } => false,
    }
}

/// Convert a parsed LiNo node into a [`Value`] using the codec's semantics.
fn convert(node: &Node) -> Value {
    match node {
        Node::Ref(reference) => reference_value(reference),
        Node::Link { id, values } => {
            if values.is_empty() {
                return id
                    .as_ref()
                    .map_or_else(|| Value::Array(Vec::new()), |inner| convert(inner));
            }
            if values.iter().all(is_pair) {
                let mut pairs = Vec::with_capacity(values.len());
                for child in values {
                    if let Node::Link {
                        values: pair_values,
                        ..
                    } = child
                    {
                        let key = match convert(&pair_values[0]) {
                            Value::Str(text) => text,
                            other => encode(&other),
                        };
                        pairs.push((key, convert(&pair_values[1])));
                    }
                }
                Value::Object(pairs)
            } else {
                Value::Array(values.iter().map(convert).collect())
            }
        }
    }
}

/// Decode Links Notation text into a [`Value`].
///
/// A LiNo syntax error is surfaced as [`crate::Error::LinoSyntax`].
pub fn decode(lino: &str) -> Result<Value> {
    let nodes = parse(lino)?;
    if nodes.is_empty() {
        return Ok(Value::Null);
    }
    let result = convert(&nodes[0]);
    // Unwrap a single primitive the parser wrapped in a one-element list.
    if let Value::Array(items) = &result {
        if items.len() == 1
            && matches!(
                items[0],
                Value::Null | Value::Bool(_) | Value::Int(_) | Value::Float(_) | Value::Str(_)
            )
        {
            return Ok(items[0].clone());
        }
    }
    Ok(result)
}

/// Whether a caller's `Accept`/`Content-Type` header opts into JSON.
///
/// Links Notation is always the default; JSON is only used when a client asks
/// for it explicitly, and Links Notation wins when both are present.
#[must_use]
pub fn prefers_json(header: Option<&str>) -> bool {
    let Some(header) = header else {
        return false;
    };
    let lower = header.to_lowercase();
    if lower.contains(LINO_CONTENT_TYPE) {
        return false;
    }
    lower.contains("application/json") || lower.contains("text/json")
}

impl From<&Link> for Value {
    fn from(link: &Link) -> Self {
        Self::Object(vec![
            ("index".to_string(), Self::Int(link.index)),
            ("source".to_string(), Self::Int(link.source)),
            ("target".to_string(), Self::Int(link.target)),
        ])
    }
}

/// Encode a slice of links as a Links Notation array.
fn links_value(links: &[Link]) -> Value {
    Value::Array(links.iter().map(Value::from).collect())
}

impl From<&MatchRow> for Value {
    fn from(row: &MatchRow) -> Self {
        let binding = Self::Object(
            row.binding
                .iter()
                .map(|(name, index)| (name.clone(), Self::Int(*index)))
                .collect(),
        );
        Self::Object(vec![
            ("links".to_string(), links_value(&row.links)),
            ("binding".to_string(), binding),
        ])
    }
}

impl From<&QueryReport> for Value {
    fn from(report: &QueryReport) -> Self {
        Self::Object(vec![
            (
                "operation".to_string(),
                Self::Str(report.operation.as_str().to_string()),
            ),
            (
                "matched".to_string(),
                Self::Array(report.matched.iter().map(Self::from).collect()),
            ),
            ("created".to_string(), links_value(&report.created)),
            ("updated".to_string(), links_value(&report.updated)),
            ("deleted".to_string(), links_value(&report.deleted)),
        ])
    }
}

impl From<&Introspection> for Value {
    fn from(info: &Introspection) -> Self {
        let names = Self::Array(
            info.names
                .iter()
                .map(|(name, index)| {
                    Self::Object(vec![
                        ("name".to_string(), Self::Str(name.clone())),
                        ("index".to_string(), Self::Int(*index)),
                    ])
                })
                .collect(),
        );
        Self::Object(vec![
            (
                "linkCount".to_string(),
                Self::Int(i64::try_from(info.link_count).unwrap_or(i64::MAX)),
            ),
            ("names".to_string(), names),
            ("links".to_string(), links_value(&info.links)),
        ])
    }
}

/// Encode a query report directly as Links Notation text.
#[must_use]
pub fn encode_report(report: &QueryReport) -> String {
    encode(&Value::from(report))
}
