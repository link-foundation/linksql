//! Tests for the Links Notation (LiNo) parser and serializer.
//!
//! Mirrors `tests/lino.test.js`. Every assertion there is a behavioural
//! requirement reproduced here.

use linksql::lino::{parse, serialize, serialize_all, tokenize, Node, Ref, Token};
use linksql::Error;

// --- tokenize ---------------------------------------------------------------

#[test]
fn tokenize_splits_structure_and_words() {
    let kinds: Vec<Token> = tokenize("(1: 1 1)").unwrap();
    assert!(matches!(kinds[0], Token::LParen));
    assert!(matches!(kinds[1], Token::Ref(Ref::Number(1))));
    assert!(matches!(kinds[2], Token::Colon));
    assert!(matches!(kinds[3], Token::Ref(Ref::Number(1))));
    assert!(matches!(kinds[4], Token::Ref(Ref::Number(1))));
    assert!(matches!(kinds[5], Token::RParen));
    assert_eq!(kinds.len(), 6);
}

#[test]
fn tokenize_reads_quoted_strings_with_escapes() {
    let tokens = tokenize("\"a\\\"b\"").unwrap();
    assert_eq!(tokens.len(), 1);
    assert_eq!(tokens[0], Token::Ref(Ref::Name("a\"b".to_string())));
}

// --- parse ------------------------------------------------------------------

#[test]
fn parse_classifies_references() {
    assert_eq!(parse("1").unwrap()[0], Node::Ref(Ref::Number(1)));
    assert_eq!(
        parse("$x").unwrap()[0],
        Node::Ref(Ref::Variable("x".to_string()))
    );
    assert_eq!(parse("*").unwrap()[0], Node::Ref(Ref::Wildcard));
    assert_eq!(
        parse("alice").unwrap()[0],
        Node::Ref(Ref::Name("alice".to_string()))
    );
}

#[test]
fn parse_link_with_explicit_identity() {
    let nodes = parse("(1: 1 1)").unwrap();
    let node = &nodes[0];
    match node {
        Node::Link { id, values } => {
            assert_eq!(id.as_deref(), Some(&Node::Ref(Ref::Number(1))));
            assert_eq!(values.len(), 2);
        }
        Node::Ref(_) => panic!("expected a link node"),
    }
}

#[test]
fn parse_the_empty_link() {
    assert_eq!(
        parse("()").unwrap()[0],
        Node::Link {
            id: None,
            values: vec![]
        }
    );
}

#[test]
fn parse_two_value_query_into_two_top_level_nodes() {
    let nodes = parse("() ((1 1))").unwrap();
    assert_eq!(nodes.len(), 2);
    match &nodes[0] {
        Node::Link { values, .. } => assert_eq!(values.len(), 0),
        Node::Ref(_) => panic!("expected link"),
    }
    match &nodes[1] {
        Node::Link { values, .. } => assert_eq!(values.len(), 1),
        Node::Ref(_) => panic!("expected link"),
    }
}

#[test]
fn parse_nested_links() {
    let nodes = parse("((1 2) (3 4))").unwrap();
    match &nodes[0] {
        Node::Link { values, .. } => {
            assert!(matches!(values[0], Node::Link { .. }));
            assert!(matches!(values[1], Node::Link { .. }));
        }
        Node::Ref(_) => panic!("expected link"),
    }
}

// The JS "rejects non-string input" test is JS-specific (N/A in Rust since the
// signature takes `&str`); skipped per the contract.

#[test]
fn parse_rejects_unterminated_strings() {
    assert!(parse("\"abc").is_err());
}

#[test]
fn parse_rejects_unbalanced_parentheses() {
    assert!(parse("(1 2").is_err());
}

#[test]
fn parse_reports_a_lino_syntax_error_instance() {
    let caught = parse("(1 2");
    assert!(matches!(caught, Err(Error::LinoSyntax { .. })));
}

// --- serialize round-trips --------------------------------------------------

#[test]
fn serialize_round_trips() {
    let samples = [
        "1",
        "(1: 1 1)",
        "() ((1 1))",
        "((1: 1 1)) ((1: 1 2))",
        "((1 2)) ()",
        "((($i: $s $t)) (($i: $s $t)))",
        "(parent (child grandchild))",
    ];
    for sample in samples {
        let nodes = parse(sample).unwrap();
        let text = serialize_all(&nodes, " ");
        assert_eq!(text, sample, "round-trip serialize for {sample}");
        // Re-parsing the output yields the same AST.
        assert_eq!(parse(&text).unwrap(), nodes, "re-parse for {sample}");
    }
}

#[test]
fn serialize_quotes_names_that_contain_structure_characters() {
    let nodes = parse("(name: \"hello world\")").unwrap();
    assert_eq!(serialize(&nodes[0]), "(name: \"hello world\")");
}
