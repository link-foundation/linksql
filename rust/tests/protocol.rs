//! Tests for the Links Notation wire protocol.
//!
//! Links Notation — not JSON — is the data transfer format. These tests pin the
//! round-trip behaviour of `encode`/`decode` (including the exact report shape
//! the engine produces) and the content negotiation that lets a caller opt into
//! the JSON projection. They mirror `js/tests/protocol.test.js` so every language
//! port speaks the same dialect.

use linksql::protocol::{decode, encode, encode_report, prefers_json, Value};
use linksql::query::{MatchRow, QueryReport};
use linksql::store::Link;
use linksql::{Database, Operation, LINO_CONTENT_TYPE};

use std::collections::BTreeMap;

#[test]
fn encodes_a_query_report_to_links_notation() {
    let mut binding = BTreeMap::new();
    binding.insert("s".to_string(), 1);
    binding.insert("t".to_string(), 2);
    let report = QueryReport {
        operation: Operation::Update,
        matched: vec![MatchRow {
            links: vec![Link {
                index: 1,
                source: 1,
                target: 1,
            }],
            binding,
        }],
        created: vec![],
        updated: vec![Link {
            index: 3,
            source: 1,
            target: 4,
        }],
        deleted: vec![],
    };
    assert_eq!(
        encode_report(&report),
        "((operation update) (matched (((links (((index 1) (source 1) \
         (target 1)))) (binding ((s 1) (t 2)))))) (created ()) (updated \
         (((index 3) (source 1) (target 4)))) (deleted ()))"
    );
}

#[test]
fn round_trips_an_arbitrary_report() {
    let report = Value::Object(vec![
        ("operation".to_string(), Value::Str("create".to_string())),
        ("matched".to_string(), Value::Array(vec![])),
        (
            "created".to_string(),
            Value::Array(vec![Value::Object(vec![
                ("index".to_string(), Value::Int(1)),
                ("source".to_string(), Value::Int(1)),
                ("target".to_string(), Value::Int(1)),
            ])]),
        ),
        ("updated".to_string(), Value::Array(vec![])),
        ("deleted".to_string(), Value::Array(vec![])),
    ]);
    assert_eq!(decode(&encode(&report)).unwrap(), report);
}

#[test]
fn encodes_an_empty_object_as_empty_link() {
    assert_eq!(encode(&Value::Object(vec![])), "()");
}

#[test]
fn prefers_links_notation_unless_json_requested() {
    assert!(!prefers_json(None));
    assert!(!prefers_json(Some(LINO_CONTENT_TYPE)));
    assert!(!prefers_json(Some("text/plain")));
    assert!(prefers_json(Some("application/json")));
    assert!(prefers_json(Some("text/json")));
    // Links Notation wins when both are present.
    assert!(!prefers_json(Some(&format!(
        "{LINO_CONTENT_TYPE}, application/json"
    ))));
}

#[test]
fn encodes_a_real_query_report() {
    let mut db = Database::new(true);
    let report = db.query("() ((1 1))").unwrap();
    let decoded = decode(&encode_report(&report)).unwrap();
    let Value::Object(pairs) = decoded else {
        panic!("expected an object");
    };
    let operation = pairs.iter().find(|(key, _)| key == "operation").unwrap();
    assert_eq!(operation.1, Value::Str("create".to_string()));
}
