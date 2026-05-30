//! The single substitution operation.
//!
//! LinksQL has exactly one operation. A query is a pair of pattern lists — a
//! **restriction** and a **substitution** — written
//! `(restriction) (substitution)`. The restriction selects existing links
//! (binding variables along the way); the substitution describes what those
//! links become. The four CRUD behaviours are not separate primitives, they are
//! derived from how the two lists line up:
//!
//! ```text
//! create  ()        ((s t))   empty restriction, one created link
//! read    ((p))               restriction only, no mutation
//! update  ((a b))   ((a c))   matched link rewritten in place
//! delete  ((a b))   ()        matched link with no replacement is removed
//! ```
//!
//! Patterns are paired positionally: `restriction[i]` becomes `substitution[i]`.
//! Any trailing restriction patterns are deletions, any trailing substitution
//! patterns are creations.
//!
//! Following the design constraint of this port, the engine is a set of free
//! functions that take the [`LinksStore`] and [`Names`] explicitly rather than a
//! context struct holding aliasing mutable references. Variable bindings use a
//! [`BTreeMap`] so iteration order is deterministic (the JavaScript binding
//! object preserves insertion order; the read tests only assert binding contents,
//! and a `BTreeMap` keyed by variable name reproduces the same observable map).

use crate::lino::{Node, Ref};
use crate::names::Names;
use crate::store::{Link, LinksStore};
use crate::{Error, Result};
use std::collections::BTreeMap;

/// A binding from variable name to resolved index.
pub type Binding = BTreeMap<String, i64>;

/// The three slots of a decomposed link pattern: `(id: source target)`.
#[derive(Debug, Clone, Copy)]
pub struct Slots<'a> {
    /// Optional identity slot.
    pub id: Option<&'a Node>,
    /// Optional source slot (`None` means "match anything"/"inherit").
    pub source: Option<&'a Node>,
    /// Optional target slot (`None` means "match anything"/"inherit").
    pub target: Option<&'a Node>,
}

/// A join row: the variable bindings plus the concrete links matched so far.
#[derive(Debug, Clone)]
pub struct Row {
    /// Variable bindings shared across the row.
    pub binding: Binding,
    /// Concrete links matched, in pattern order.
    pub links: Vec<Link>,
}

/// A concrete `{index?, source, target}` produced by materialising a pattern.
#[derive(Debug, Clone, Copy)]
pub struct Spec {
    /// Explicit identity, if the pattern specified one.
    pub index: Option<i64>,
    /// Resolved source index.
    pub source: i64,
    /// Resolved target index.
    pub target: i64,
}

/// The raw result of [`execute`] before it is shaped into a report.
#[derive(Debug, Clone, Default)]
pub struct RawResult {
    /// The join rows.
    pub matches: Vec<Row>,
    /// Links created (including nested-link side effects).
    pub created: Vec<Link>,
    /// Links updated (final structure).
    pub updated: Vec<Link>,
    /// Links removed (pre-mutation structure).
    pub deleted: Vec<Link>,
}

/// Decompose a link pattern node into its three slots.
///
/// A doublet pattern is `(id: source target)`. The identity slot is optional, and
/// a pattern may also be written `()` (match anything) or `(id)` (match a single
/// identity, any structure).
pub fn link_slots(node: &Node) -> Result<Slots<'_>> {
    let Node::Link { id, values } = node else {
        return Err(Error::Substitution(
            "Each restriction/substitution pattern must be a link".to_string(),
        ));
    };
    let id = id.as_deref();
    match values.len() {
        2 => Ok(Slots {
            id,
            source: Some(&values[0]),
            target: Some(&values[1]),
        }),
        0 => Ok(Slots {
            id,
            source: None,
            target: None,
        }),
        1 if id.is_none() => Ok(Slots {
            id: Some(&values[0]),
            source: None,
            target: None,
        }),
        n => Err(Error::Substitution(format!(
            "A link pattern must have 0 or 2 values (got {n})"
        ))),
    }
}

/// Resolve a value node to a concrete link index for *matching* purposes.
///
/// Returns `None` when the value cannot resolve (an unknown name, an unmatched
/// nested structure, or a variable/wildcard which are handled by the caller).
fn resolve_for_match(
    node: &Node,
    binding: &Binding,
    store: &LinksStore,
    names: &Names,
) -> Option<i64> {
    let _ = binding; // mirrors JS: matching resolution ignores the binding here
    match node {
        Node::Ref(Ref::Number(value)) => Some(*value),
        Node::Ref(Ref::Name(name)) => names.resolve(name),
        // Variables and wildcards are handled by the caller (`match_slot`).
        Node::Ref(Ref::Variable(_) | Ref::Wildcard) => None,
        Node::Link { .. } => {
            let slots = link_slots(node).ok()?;
            let source = resolve_for_match(slots.source?, binding, store, names)?;
            let target = resolve_for_match(slots.target?, binding, store, names)?;
            store.find_by_pair(source, target).map(|link| link.index)
        }
    }
}

/// Constrain one slot of a pattern against an actual value, updating bindings.
///
/// `None` slot → matches; wildcard → matches; variable → binds or checks; any
/// other reference must resolve (for matching) and equal `actual`.
fn match_slot(
    slot: Option<&Node>,
    actual: i64,
    binding: &mut Binding,
    store: &LinksStore,
    names: &Names,
) -> bool {
    let Some(slot) = slot else {
        return true;
    };
    if matches!(slot, Node::Ref(Ref::Wildcard)) {
        return true;
    }
    if let Node::Ref(Ref::Variable(name)) = slot {
        // A variable binds to `actual` the first time it is seen and must equal
        // its bound value on every later occurrence within the row.
        return *binding.entry(name.clone()).or_insert(actual) == actual;
    }
    resolve_for_match(slot, binding, store, names) == Some(actual)
}

/// Test a single pattern against a single link, extending the binding in place.
///
/// Slots are matched left → right with short-circuiting AND, mutating the same
/// binding so a variable bound by the source constrains the target.
pub fn match_one(
    pattern: &Node,
    link: &Link,
    binding: &mut Binding,
    store: &LinksStore,
    names: &Names,
) -> bool {
    let Ok(slots) = link_slots(pattern) else {
        return false;
    };
    match_slot(slots.id, link.index, binding, store, names)
        && match_slot(slots.source, link.source, binding, store, names)
        && match_slot(slots.target, link.target, binding, store, names)
}

/// Join all restriction patterns into a set of binding rows. Each row records the
/// concrete link matched by every pattern, in order, so the substitution can pair
/// with them positionally.
fn join_restriction(
    patterns: &[Node],
    store: &LinksStore,
    names: &Names,
    snapshot: &[Link],
) -> Vec<Row> {
    let mut rows = vec![Row {
        binding: Binding::new(),
        links: Vec::new(),
    }];
    for pattern in patterns {
        let mut next = Vec::new();
        for row in &rows {
            for link in snapshot {
                let mut binding = row.binding.clone();
                if match_one(pattern, link, &mut binding, store, names) {
                    let mut links = row.links.clone();
                    links.push(*link);
                    next.push(Row { binding, links });
                }
            }
        }
        rows = next;
    }
    rows
}

/// Match a restriction against the store without mutating anything (the read
/// path). Joins over the live store.
#[must_use]
pub fn match_restriction(restriction: &[Node], store: &LinksStore, names: &Names) -> Vec<Row> {
    let snapshot = store.all();
    join_restriction(restriction, store, names, &snapshot)
}

/// Test whether a single link satisfies at least one of the given patterns.
///
/// Each pattern is tried with a fresh binding. An empty pattern list matches
/// every link.
#[must_use]
pub fn link_matches(patterns: &[Node], link: &Link, store: &LinksStore, names: &Names) -> bool {
    if patterns.is_empty() {
        return true;
    }
    patterns.iter().any(|pattern| {
        let mut binding = Binding::new();
        match_one(pattern, link, &mut binding, store, names)
    })
}

/// Resolve a value node to a concrete index when *producing* output. Unlike
/// matching, every reference must resolve: unbound variables and wildcards are
/// errors, and names are auto-created when the context allows it. Nested links
/// that do not already exist are created as a side effect and pushed to
/// `created`.
fn resolve_for_output(
    node: &Node,
    binding: &Binding,
    store: &mut LinksStore,
    names: &mut Names,
    created: &mut Vec<Link>,
) -> Result<i64> {
    match node {
        Node::Ref(Ref::Number(value)) => Ok(*value),
        Node::Ref(Ref::Variable(name)) => binding.get(name).copied().ok_or_else(|| {
            Error::Substitution(format!("Unbound variable ${name} in substitution"))
        }),
        Node::Ref(Ref::Wildcard) => Err(Error::Substitution(
            "Wildcard * cannot appear in a substitution".to_string(),
        )),
        // Names auto-create via `names.ensure` (which itself may `store.create`);
        // those point links are NOT pushed to `created` (only explicit links are).
        Node::Ref(Ref::Name(name)) => names.ensure(store, name),
        Node::Link { .. } => {
            let slots = link_slots(node)?;
            let (Some(source_node), Some(target_node)) = (slots.source, slots.target) else {
                return Err(Error::Substitution(
                    "Nested link must have a source and a target".to_string(),
                ));
            };
            let source = resolve_for_output(source_node, binding, store, names, created)?;
            let target = resolve_for_output(target_node, binding, store, names, created)?;
            let index = match slots.id {
                Some(id_node) => Some(resolve_for_output(id_node, binding, store, names, created)?),
                None => None,
            };
            if let Some(existing) = store.find_by_pair(source, target) {
                return Ok(existing.index);
            }
            let link = store.create(index, source, target)?;
            created.push(link);
            Ok(link.index)
        }
    }
}

/// Turn a substitution pattern into a concrete [`Spec`].
///
/// If both source and target slots are absent, there MUST be a `matched` link to
/// inherit structure from; otherwise both slots are resolved for output.
fn materialize(
    pattern: &Node,
    binding: &Binding,
    store: &mut LinksStore,
    names: &mut Names,
    created: &mut Vec<Link>,
    matched: Option<Link>,
) -> Result<Spec> {
    let slots = link_slots(pattern)?;
    let index = match slots.id {
        Some(id_node) => Some(resolve_for_output(id_node, binding, store, names, created)?),
        None => None,
    };
    match (slots.source, slots.target) {
        (None, _) | (_, None) => {
            let matched = matched.ok_or_else(|| {
                Error::Substitution("A created link must specify a source and a target".to_string())
            })?;
            Ok(Spec {
                index,
                source: matched.source,
                target: matched.target,
            })
        }
        (Some(source_node), Some(target_node)) => {
            let source = resolve_for_output(source_node, binding, store, names, created)?;
            let target = resolve_for_output(target_node, binding, store, names, created)?;
            Ok(Spec {
                index,
                source,
                target,
            })
        }
    }
}

/// Execute one substitution operation against the store.
///
/// Matching uses a pre-mutation snapshot, so the operation observes the store as
/// it was at the start; side-effect link creation during output resolution is
/// the only way the live store changes mid-operation.
pub fn execute(
    restriction: &[Node],
    substitution: &[Node],
    store: &mut LinksStore,
    names: &mut Names,
) -> Result<RawResult> {
    let snapshot = store.all();
    let rows = join_restriction(restriction, store, names, &snapshot);
    let mut result = RawResult::default();
    let paired = restriction.len().min(substitution.len());

    for row in rows {
        // Update pass: pair restriction[i] with substitution[i].
        for (i, sub) in substitution.iter().enumerate().take(paired) {
            let matched = row.links[i];
            if !store.has(matched.index) {
                continue; // already removed by an earlier row
            }
            let spec = materialize(
                sub,
                &row.binding,
                store,
                names,
                &mut result.created,
                Some(matched),
            )?;
            let updated = store.update(matched.index, spec.source, spec.target, spec.index)?;
            result.updated.push(updated);
        }

        // Delete pass: trailing restriction patterns with no replacement.
        for i in paired..restriction.len() {
            let matched = row.links[i];
            if store.delete(matched.index) {
                result.deleted.push(matched);
            }
        }

        // Create pass: trailing substitution patterns with no match.
        for sub in substitution.iter().skip(paired) {
            let spec = materialize(sub, &row.binding, store, names, &mut result.created, None)?;
            let link = store.create(spec.index, spec.source, spec.target)?;
            result.created.push(link);
        }

        result.matches.push(row);
    }

    Ok(result)
}
