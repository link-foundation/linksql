//! Tests for the store, the substitution engine and the query executor — the
//! heart of LinksQL.
//!
//! Mirrors `tests/engine.test.js`. The CRUD examples mirror the canonical
//! operations from the specification.

use linksql::names::Names;
use linksql::query::{link_to_lino, split_query, Database, Operation};
use linksql::store::{Link, LinksStore};
use linksql::{parse, Error};
use std::collections::BTreeMap;

/// Build a binding map from `(name, index)` pairs for comparison.
fn binding(pairs: &[(&str, i64)]) -> BTreeMap<String, i64> {
    pairs
        .iter()
        .map(|(name, index)| ((*name).to_string(), *index))
        .collect()
}

// --- LinksStore -------------------------------------------------------------

#[test]
fn store_creates_and_deduplicates_by_source_target() {
    let mut store = LinksStore::new();
    let a = store.create(None, 1, 1).unwrap();
    let b = store.create(None, 1, 1).unwrap();
    assert_eq!(a.index, b.index);
    assert_eq!(store.size(), 1);
}

#[test]
fn store_allocates_fresh_identities_that_skip_used_ones() {
    let mut store = LinksStore::new();
    store.create(Some(1), 1, 1).unwrap();
    let next = store.create(None, 2, 3).unwrap();
    assert_eq!(next.index, 2);
}

#[test]
fn store_rejects_conflicting_explicit_identities() {
    let mut store = LinksStore::new();
    store.create(Some(5), 1, 2).unwrap();
    let result = store.create(Some(6), 1, 2);
    assert!(matches!(result, Err(Error::LinkIntegrity(_))));
}

#[test]
fn store_updates_structure_while_keeping_identity() {
    let mut store = LinksStore::new();
    let link = store.create(None, 1, 1).unwrap();
    let updated = store.update(link.index, 1, 2, None).unwrap();
    assert_eq!(updated.index, link.index);
    assert_eq!(updated.target, 2);
    assert_eq!(store.find_by_pair(1, 1), None);
}

#[test]
fn store_throws_on_integrity_violations() {
    let mut store = LinksStore::new();
    let result = store.update(99, 1, 1, None);
    assert!(matches!(result, Err(Error::LinkIntegrity(_))));
}

// --- Database CRUD via the single substitution operation --------------------

#[test]
fn create_makes_a_point() {
    let mut db = Database::new(true);
    let report = db.query("() ((1 1))").unwrap();
    assert_eq!(report.operation, Operation::Create);
    assert_eq!(
        report.created,
        vec![Link {
            index: 1,
            source: 1,
            target: 1
        }]
    );
    assert_eq!(db.count(), 1);
}

#[test]
fn read_lone_restriction_returns_matches_without_mutating() {
    let mut db = Database::new(true);
    db.query("() ((1 1))").unwrap();
    let report = db.query("((1: 1 1))").unwrap();
    assert_eq!(report.operation, Operation::Read);
    assert_eq!(report.matched.len(), 1);
    assert_eq!(
        report.matched[0].links[0],
        Link {
            index: 1,
            source: 1,
            target: 1
        }
    );
    assert!(report.created.is_empty());
    assert!(report.updated.is_empty());
    assert!(report.deleted.is_empty());
}

#[test]
fn read_variables_bind_to_every_link_in_order() {
    let mut db = Database::new(true);
    db.query("() ((1 1))").unwrap();
    db.query("() ((1 2))").unwrap();
    let report = db.query("(($i: $s $t))").unwrap();
    assert_eq!(report.operation, Operation::Read);
    assert_eq!(report.matched.len(), 2);
    let bindings: Vec<_> = report
        .matched
        .iter()
        .map(|row| row.binding.clone())
        .collect();
    assert_eq!(
        bindings,
        vec![
            binding(&[("i", 1), ("s", 1), ("t", 1)]),
            binding(&[("i", 2), ("s", 1), ("t", 2)]),
        ]
    );
}

#[test]
fn update_rewrites_in_place() {
    let mut db = Database::new(true);
    db.query("() ((1 1))").unwrap();
    let report = db.query("((1: 1 1)) ((1: 1 2))").unwrap();
    assert_eq!(report.operation, Operation::Update);
    assert_eq!(
        report.updated,
        vec![Link {
            index: 1,
            source: 1,
            target: 2
        }]
    );
    assert_eq!(db.count(), 1);
}

#[test]
fn delete_removes_the_match() {
    let mut db = Database::new(true);
    db.query("() ((1 2))").unwrap();
    let report = db.query("((1 2)) ()").unwrap();
    assert_eq!(report.operation, Operation::Delete);
    assert_eq!(
        report.deleted,
        vec![Link {
            index: 1,
            source: 1,
            target: 2
        }]
    );
    assert_eq!(db.count(), 0);
}

#[test]
fn non_matching_restriction_makes_no_changes() {
    let mut db = Database::new(true);
    db.query("() ((1 1))").unwrap();
    let report = db.query("((9: 9 9)) ((9: 9 8))").unwrap();
    assert_eq!(report.operation, Operation::Noop);
    assert_eq!(db.count(), 1);
}

// --- conjunctive join across patterns ---------------------------------------

#[test]
fn conjunctive_join_composes_edges_by_sharing_a_variable() {
    let mut db = Database::new(true);
    // Edges 1->2 and 2->3 (identities allocated automatically).
    db.query("() ((1 2))").unwrap();
    db.query("() ((2 3))").unwrap();
    // Match a 2-hop path: ($x -> $y) and ($y -> $z).
    let report = db.query("(($x $y) ($y $z))").unwrap();
    assert_eq!(report.operation, Operation::Read);
    assert_eq!(report.matched.len(), 1);
    assert_eq!(
        report.matched[0].binding,
        binding(&[("x", 1), ("y", 2), ("z", 3)])
    );
}

// --- named references -------------------------------------------------------

#[test]
fn named_auto_creates_names_as_points_and_links_them() {
    let mut db = Database::new(true);
    let report = db.query("() ((alice bob))").unwrap();
    assert_eq!(report.operation, Operation::Create);
    // alice and bob become points; the relation links them.
    assert_eq!(db.count(), 3);
    let alice = db.names.resolve("alice").unwrap();
    let bob = db.names.resolve("bob").unwrap();
    assert!(db.store.find_by_pair(alice, bob).is_some());
}

#[test]
fn named_honours_auto_create_false() {
    let mut store = LinksStore::new();
    let mut names = Names::new(false);
    let result = names.ensure(&mut store, "ghost");
    assert!(matches!(result, Err(Error::UnknownName(_))));
}

// --- splitQuery -------------------------------------------------------------

#[test]
fn split_query_treats_one_node_as_a_read() {
    let nodes = parse("((1: 1 1))").unwrap();
    let (_restriction, substitution) = split_query(&nodes).unwrap();
    assert!(substitution.is_none());
}

#[test]
fn split_query_treats_two_nodes_as_restriction_plus_substitution() {
    let nodes = parse("((1 1)) ((1 2))").unwrap();
    let (restriction, substitution) = split_query(&nodes).unwrap();
    assert_eq!(restriction.len(), 1);
    assert_eq!(substitution.unwrap().len(), 1);
}

#[test]
fn split_query_rejects_more_than_two_top_level_nodes() {
    let nodes = parse("(1) (2) (3)").unwrap();
    assert!(split_query(&nodes).is_err());
}

// --- serialisation and introspection ----------------------------------------

#[test]
fn serialises_links_to_canonical_lino() {
    assert_eq!(
        link_to_lino(&Link {
            index: 3,
            source: 1,
            target: 2
        }),
        "(3: 1 2)"
    );
}

#[test]
fn round_trips_the_whole_database_through_lino() {
    let mut db = Database::new(true);
    db.query("() ((1 1))").unwrap();
    db.query("() ((1 2))").unwrap();
    let text = db.to_lino();
    let mut restored = Database::new(true);
    restored.import_lino(&text).unwrap();
    assert_eq!(restored.to_lino(), text);
}

#[test]
fn introspects_link_count_and_names() {
    let mut db = Database::new(true);
    db.query("() ((alice bob))").unwrap();
    let info = db.introspect();
    assert_eq!(info.link_count, 3);
    assert!(info.names.iter().any(|(name, _)| name == "alice"));
}
