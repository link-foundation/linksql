//! High-level query executor: the public face of the engine.
//!
//! A [`Database`] bundles a links store with a name registry and exposes a single
//! [`Database::query`] method that accepts LiNo text. The text is parsed into a
//! restriction and a substitution, the operation runs, and a structured report
//! comes back describing what matched and what changed.

use crate::lino::{parse, serialize, Node};
use crate::names::Names;
use crate::store::{Link, LinksStore};
use crate::substitution::{execute, match_restriction, Binding, RawResult};
use crate::{Error, Result};

/// The kind of operation a query performed.
///
/// Mirrors the JavaScript string operation names (`read`, `create`, `update`,
/// `delete`, `mixed`, `noop`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    /// A read-only query (restriction only).
    Read,
    /// Exactly one link was created.
    Create,
    /// Exactly one link was updated.
    Update,
    /// Exactly one link was deleted.
    Delete,
    /// More than one kind of mutation occurred.
    Mixed,
    /// No mutation occurred (and the query was not read-only).
    Noop,
}

impl Operation {
    /// The canonical lowercase name, matching the JavaScript report string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Create => "create",
            Self::Update => "update",
            Self::Delete => "delete",
            Self::Mixed => "mixed",
            Self::Noop => "noop",
        }
    }
}

/// One join row in a query report: the matched links and the variable bindings.
#[derive(Debug, Clone)]
pub struct MatchRow {
    /// The concrete links matched, in pattern order.
    pub links: Vec<Link>,
    /// The variable bindings as `{ name: index }`.
    pub binding: Binding,
}

/// A structured report describing what a query matched and changed.
#[derive(Debug, Clone)]
pub struct QueryReport {
    /// The classified operation.
    pub operation: Operation,
    /// The join rows.
    pub matched: Vec<MatchRow>,
    /// Links created (including nested-link side effects).
    pub created: Vec<Link>,
    /// Links updated (final structure).
    pub updated: Vec<Link>,
    /// Links removed.
    pub deleted: Vec<Link>,
}

/// Extract the pattern list from a restriction/substitution wrapper node.
///
/// The node MUST be a link with no `id` (a parenthesised list of patterns).
fn patterns_of(node: &Node) -> Result<Vec<Node>> {
    match node {
        Node::Link { id: None, values } => Ok(values.clone()),
        _ => Err(Error::Query(
            "A restriction or substitution must be a parenthesised list of patterns".to_string(),
        )),
    }
}

/// Split parsed LiNo nodes into a restriction and an (optional) substitution.
///
/// Zero or one top-level node is a read; two nodes are the canonical
/// `(restriction) (substitution)` form; anything else is ambiguous.
pub fn split_query(nodes: &[Node]) -> Result<(Vec<Node>, Option<Vec<Node>>)> {
    match nodes.len() {
        0 => Ok((Vec::new(), None)),
        1 => Ok((patterns_of(&nodes[0])?, None)),
        2 => Ok((patterns_of(&nodes[0])?, Some(patterns_of(&nodes[1])?))),
        _ => Err(Error::Query(
            "A query must be \"(restriction)\" or \"(restriction) (substitution)\"".to_string(),
        )),
    }
}

/// Serialise a link to canonical LiNo text, e.g. `(3: 1 2)`.
#[must_use]
pub fn link_to_lino(link: &Link) -> String {
    let node = Node::Link {
        id: Some(Box::new(Node::Ref(crate::lino::Ref::Number(link.index)))),
        values: vec![
            Node::Ref(crate::lino::Ref::Number(link.source)),
            Node::Ref(crate::lino::Ref::Number(link.target)),
        ],
    };
    serialize(&node)
}

/// Classify a change report into an operation name.
///
/// Read-only queries are always `read`. Otherwise the non-empty kinds among
/// created/updated/deleted are counted: none → `noop`, exactly one → that kind,
/// more than one → `mixed`.
fn classify(raw: &RawResult, read_only: bool) -> Operation {
    if read_only {
        return Operation::Read;
    }
    let kinds = [
        (!raw.created.is_empty()).then_some(Operation::Create),
        (!raw.updated.is_empty()).then_some(Operation::Update),
        (!raw.deleted.is_empty()).then_some(Operation::Delete),
    ];
    let mut present = kinds.into_iter().flatten();
    match (present.next(), present.next()) {
        (None, _) => Operation::Noop,
        (Some(only), None) => only,
        (Some(_), Some(_)) => Operation::Mixed,
    }
}

/// A snapshot returned by [`Database::introspect`].
#[derive(Debug, Clone)]
pub struct Introspection {
    /// The number of links.
    pub link_count: usize,
    /// Every `(name, index)` association in the registry.
    pub names: Vec<(String, i64)>,
    /// Every stored link.
    pub links: Vec<Link>,
}

/// An associative database queried with the single substitution operation.
#[derive(Debug, Clone)]
pub struct Database {
    /// The backing links store.
    pub store: LinksStore,
    /// The name registry.
    pub names: Names,
}

impl Database {
    /// Create an empty database with the given auto-create behaviour.
    #[must_use]
    pub fn new(auto_create: bool) -> Self {
        Self {
            store: LinksStore::new(),
            names: Names::new(auto_create),
        }
    }

    /// Run a LinksQL query expressed as LiNo text.
    ///
    /// A LiNo syntax error is wrapped as a query error (`Invalid LiNo: ...`); a
    /// substitution error is surfaced as a query error too, so all malformed
    /// queries fail as [`Error::Query`].
    pub fn query(&mut self, text: &str) -> Result<QueryReport> {
        let nodes = parse(text).map_err(|error| Error::Query(format!("Invalid LiNo: {error}")))?;
        let (restriction, substitution) = split_query(&nodes)?;
        let read_only = substitution.is_none();

        // Destructure so the free functions can borrow store and names
        // simultaneously without aliasing through `self`.
        let Self { store, names } = self;
        let raw = if read_only {
            RawResult {
                matches: match_restriction(&restriction, store, names),
                ..RawResult::default()
            }
        } else {
            let substitution = substitution.unwrap_or_default();
            // A substitution error becomes a query error (other errors, like a
            // store integrity error, propagate unchanged).
            match execute(&restriction, &substitution, store, names) {
                Ok(raw) => raw,
                Err(Error::Substitution(message)) => return Err(Error::Query(message)),
                Err(other) => return Err(other),
            }
        };

        let report = QueryReport {
            operation: classify(&raw, read_only),
            matched: raw
                .matches
                .into_iter()
                .map(|row| MatchRow {
                    links: row.links,
                    binding: row.binding,
                })
                .collect(),
            created: raw.created,
            updated: raw.updated,
            deleted: raw.deleted,
        };
        Ok(report)
    }

    /// All stored links.
    #[must_use]
    pub fn links(&self) -> Vec<Link> {
        self.store.all()
    }

    /// Number of links currently stored.
    #[must_use]
    pub fn count(&self) -> usize {
        self.store.size()
    }

    /// Serialise the whole database to canonical LiNo, one link per line.
    #[must_use]
    pub fn to_lino(&self) -> String {
        self.store
            .all()
            .iter()
            .map(link_to_lino)
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Bulk-import links from LiNo text (each top-level link is created).
    ///
    /// Returns the number of links imported.
    pub fn import_lino(&mut self, text: &str) -> Result<usize> {
        let nodes = parse(text)?;
        let mut count = 0;
        for node in &nodes {
            let report = self.query(&format!("() ({})", serialize(node)))?;
            count += report.created.len();
        }
        Ok(count)
    }

    /// Describe the database for introspection tooling.
    #[must_use]
    pub fn introspect(&self) -> Introspection {
        Introspection {
            link_count: self.store.size(),
            names: self.names.entries(),
            links: self.store.all(),
        }
    }

    /// Remove every link and name.
    pub fn clear(&mut self) {
        self.store.clear();
        self.names.clear();
    }
}
