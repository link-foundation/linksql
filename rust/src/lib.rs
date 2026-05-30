//! Rust reference implementation of **LinksQL** — an associative query language
//! built around a single substitution operation.
//!
//! This crate is a faithful, behaviourally-identical port of the JavaScript
//! reference implementation in `../src`. The normative specification lives in
//! [`../docs/SPECIFICATION.md`](https://github.com/link-foundation/linksql/blob/main/docs/SPECIFICATION.md).
//!
//! # Data model
//!
//! Everything is a [`store::Link`] — a triple `(index: source target)` of
//! positive integers. A link whose `source` and `target` both equal its own
//! `index` is a *point*, the atom of the graph. The [`store::LinksStore`] owns
//! identity allocation and enforces structural deduplication: a `(source,
//! target)` pair identifies at most one link.
//!
//! # The single operation
//!
//! A query is a pair of pattern lists — a *restriction* and a *substitution* —
//! written `(restriction) (substitution)`. The four CRUD behaviours (read,
//! create, update, delete) are derived from how the two lists line up
//! positionally. See [`query::Database`] for the public entry point.
//!
//! # Error handling
//!
//! All fallible functions return [`Result<T>`], aliasing
//! `core::result::Result<T, Error>`. A single [`Error`] enum carries one variant
//! per concern (LiNo syntax, link integrity, unknown name, substitution, query),
//! mirroring the distinct error classes of the JavaScript reference. Tests assert
//! the variant via `matches!`, e.g. `matches!(err, Error::LinkIntegrity(_))`.

pub mod lino;
pub mod names;
pub mod protocol;
pub mod query;
pub mod schema;
pub mod store;
pub mod substitution;

// Re-export the primary surface so callers can `use linksql::{...}` directly,
// mirroring the flat module of the JavaScript package entry point.
pub use lino::{parse, serialize, serialize_all, tokenize, Node, Ref, Token};
pub use names::Names;
pub use protocol::{
    decode, encode, encode_report, prefers_json, Value, JSON_CONTENT_TYPE, LINO_CONTENT_TYPE,
};
pub use query::{
    link_to_lino, split_query, Database, Introspection, MatchRow, Operation, QueryReport,
};
pub use schema::{NamedQuery, NamedSubscription, Relation, Schema};
pub use store::{Link, LinksStore};
pub use substitution::{
    execute, link_matches, link_slots, match_restriction, RawResult, Row, Slots, Spec,
};

use core::fmt;

/// A single error type covering every failure mode of the engine.
///
/// Each variant corresponds to a distinct error class in the JavaScript
/// reference implementation:
///
/// - [`Error::LinoSyntax`] ⇔ `LinoSyntaxError` (carries a message and the
///   zero-based source position, `-1` when not applicable).
/// - [`Error::LinkIntegrity`] ⇔ `LinkIntegrityError`.
/// - [`Error::UnknownName`] ⇔ `UnknownNameError`.
/// - [`Error::Substitution`] ⇔ `SubstitutionError`.
/// - [`Error::Query`] ⇔ `QueryError`.
/// - [`Error::Schema`] ⇔ `SchemaError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// LiNo input could not be parsed. `position` is the zero-based offset of the
    /// offending character, or `-1` when no position applies.
    LinoSyntax {
        /// Human readable description (without the position suffix).
        message: String,
        /// Zero-based offset of the offending character, or `-1`.
        position: i64,
    },
    /// A store operation would violate model integrity.
    LinkIntegrity(String),
    /// An unknown name was used while auto-creation is disabled.
    UnknownName(String),
    /// A substitution could not be carried out.
    Substitution(String),
    /// Query text was well-formed LiNo but not a valid query.
    Query(String),
    /// A schema document was malformed or violated.
    Schema(String),
}

impl Error {
    /// Construct a [`Error::LinoSyntax`] from a message and position.
    #[must_use]
    pub fn lino_syntax(message: impl Into<String>, position: i64) -> Self {
        Self::LinoSyntax {
            message: message.into(),
            position,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            // Mirrors the JavaScript `LinoSyntaxError` message format: the
            // position suffix is appended only when it is non-negative.
            Self::LinoSyntax { message, position } => {
                if *position >= 0 {
                    write!(f, "{message} (at position {position})")
                } else {
                    write!(f, "{message}")
                }
            }
            Self::LinkIntegrity(message)
            | Self::Substitution(message)
            | Self::Query(message)
            | Self::Schema(message) => {
                write!(f, "{message}")
            }
            Self::UnknownName(name) => write!(f, "Unknown named reference: {name}"),
        }
    }
}

impl std::error::Error for Error {}

/// Convenience alias for results produced throughout the crate.
pub type Result<T> = core::result::Result<T, Error>;
