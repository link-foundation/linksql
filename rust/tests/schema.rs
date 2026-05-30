//! Tests for the GraphQL-class schema layer: parsing a schema written in Links
//! Notation, inferring scalar types, looking declarations up, rendering the
//! schema back to LiNo, and rejecting malformed input.
//!
//! These mirror the non-networked parts of `js/tests/schema.test.js`. The Rust
//! port is engine-only, so the server-generation suite has no counterpart here.

use linksql::{Error, Schema};

const SCHEMA_TEXT: &str = "(schema social
  (type Person)
  (type Post)
  (relation name (from Person) (to Text))
  (relation author (from Post) (to Person))
  (relation likes (from Person) (to Post))
  (query everyone (($p: $p $p)))
  (subscription newLikes ((1 $post))))";

#[test]
fn parses_types_relations_queries_and_subscriptions() {
    let schema = Schema::parse(SCHEMA_TEXT).unwrap();
    assert_eq!(schema.name.as_deref(), Some("social"));
    assert_eq!(schema.types, ["Person", "Post"]);
    assert_eq!(schema.relations.len(), 3);
    let author = schema.relation("author").unwrap();
    assert_eq!(author.from, "Post");
    assert_eq!(author.to, "Person");
    assert_eq!(schema.query("everyone").unwrap().text, "(($p: $p $p))");
    assert_eq!(
        schema.subscription("newLikes").unwrap().pattern,
        "((1 $post))"
    );
}

#[test]
fn infers_scalar_types_from_relation_endpoints() {
    let schema = Schema::parse(SCHEMA_TEXT).unwrap();
    // `Text` is referenced but never declared as a type, so it is a scalar.
    assert_eq!(schema.scalars, ["Text"]);
    assert!(schema.knows("Person"));
    assert!(schema.knows("Text"));
    assert!(schema.knows("likes"));
    assert!(!schema.knows("missing"));
}

#[test]
fn exposes_introspection_fields() {
    // The Rust port has no `introspect()`; the public fields are the
    // introspection document.
    let schema = Schema::parse(SCHEMA_TEXT).unwrap();
    assert_eq!(schema.name.as_deref(), Some("social"));
    assert_eq!(schema.types, ["Person", "Post"]);
    let relation_names: Vec<&str> = schema.relations.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(relation_names, ["name", "author", "likes"]);
    let query_names: Vec<&str> = schema.queries.iter().map(|q| q.name.as_str()).collect();
    assert_eq!(query_names, ["everyone"]);
    let sub_names: Vec<&str> = schema
        .subscriptions
        .iter()
        .map(|s| s.name.as_str())
        .collect();
    assert_eq!(sub_names, ["newLikes"]);
}

#[test]
fn round_trips_through_links_notation() {
    let schema = Schema::parse(SCHEMA_TEXT).unwrap();
    let reparsed = Schema::parse(&schema.to_lino()).unwrap();
    assert_eq!(reparsed, schema);
}

#[test]
fn validates_relations() {
    let schema = Schema::parse(SCHEMA_TEXT).unwrap();
    assert_eq!(schema.validate_relation("likes").unwrap().name, "likes");
    let err = schema.validate_relation("missing").unwrap_err();
    assert!(matches!(err, Error::Schema(_)));
    assert_eq!(err.to_string(), "Unknown relation \"missing\"");
}

#[test]
fn rejects_malformed_schemas() {
    assert!(matches!(Schema::parse("(person)"), Err(Error::Schema(_))));
    assert!(matches!(
        Schema::parse("(schema (relation r (from A)))"),
        Err(Error::Schema(_))
    ));
    assert!(matches!(
        Schema::parse("(schema (mutate x))"),
        Err(Error::Schema(_))
    ));
}
