//! LinksQL schemas — the GraphQL-class API layer.
//!
//! The issue asks LinksQL to be "robust enough to replace GraphQL", which means
//! offering the features developers expect from GraphQL: a declarative schema,
//! introspection, and named operations and subscriptions. The JavaScript
//! reference also generates a running server from a schema; this Rust port is
//! engine-only, so it supplies just the schema data model (parse, lookups,
//! validate, round-trip), not any server generation.
//!
//! A schema is itself written in Links Notation (the data protocol), so the same
//! notation describes data *and* the shape of the API that serves it:
//!
//! ```text
//! (schema social
//!   (type Person)
//!   (type Post)
//!   (relation name (from Person) (to Text))
//!   (relation author (from Post) (to Person))
//!   (relation likes (from Person) (to Post))
//!   (query everyone (($p: $p $p)))
//!   (subscription newLikes ((likes $p $post))))
//! ```
//!
//! The GraphQL analogy is direct:
//!   - `type`         ⇔ object type
//!   - `relation`     ⇔ a typed field/edge (`from` → `to`)
//!   - a scalar type  ⇔ any relation endpoint that is not a declared object type
//!   - `query`        ⇔ a named, reusable read (a query template)
//!   - `subscription` ⇔ a named live feed (a restriction streamed as it changes)
//!   - the public fields ⇔ the `__schema` introspection document

use crate::lino::{parse, serialize, serialize_all, Node, Ref};
use crate::{Error, Result};

/// The declaration keywords a schema understands.
const KEYWORDS: [&str; 4] = ["type", "relation", "query", "subscription"];

/// A typed relation — the GraphQL field/edge, declared as `from` → `to`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Relation {
    /// The relation name.
    pub name: String,
    /// The source endpoint type.
    pub from: String,
    /// The target endpoint type.
    pub to: String,
}

/// A named, reusable read — a query template.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NamedQuery {
    /// The query name.
    pub name: String,
    /// The query text in Links Notation.
    pub text: String,
}

/// A named live feed — a restriction streamed as it changes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NamedSubscription {
    /// The subscription name.
    pub name: String,
    /// The watched pattern in Links Notation.
    pub pattern: String,
}

/// A declarative description of a LinksQL API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Schema {
    /// The schema's optional name.
    pub name: Option<String>,
    /// Declared object type names.
    pub types: Vec<String>,
    /// Scalar type names: relation endpoints that are not declared object types.
    pub scalars: Vec<String>,
    /// Typed relations (the GraphQL fields/edges).
    pub relations: Vec<Relation>,
    /// Named read templates.
    pub queries: Vec<NamedQuery>,
    /// Named live feeds.
    pub subscriptions: Vec<NamedSubscription>,
}

/// Read a reference node's name as a string.
///
/// Mirrors the JavaScript `refName`: variables keep their leading `$`, numbers
/// and wildcards take their textual form, and a non-reference node is an error.
fn ref_name(node: Option<&Node>, context: &str) -> Result<String> {
    match node {
        Some(Node::Ref(r)) => Ok(match r {
            Ref::Variable(name) => format!("${name}"),
            Ref::Number(value) => value.to_string(),
            Ref::Name(name) => name.clone(),
            Ref::Wildcard => "*".to_string(),
        }),
        _ => Err(Error::Schema(format!("Expected a name for {context}"))),
    }
}

/// Find a `(keyword value)` sub-link among a declaration's values and return the
/// value's name.
///
/// Mirrors the JavaScript `namedArg`.
fn named_arg(values: &[Node], keyword: &str, context: &str) -> Result<String> {
    for value in values {
        if let Node::Link { values: inner, .. } = value {
            if inner.len() == 2 {
                if let Node::Ref(Ref::Name(name)) = &inner[0] {
                    if name == keyword {
                        return ref_name(inner.get(1), &format!("{keyword} of {context}"));
                    }
                }
            }
        }
    }
    Err(Error::Schema(format!(
        "Relation \"{context}\" is missing its \"{keyword}\" type"
    )))
}

/// The accumulating collections sorted out of a schema's declarations.
#[derive(Default)]
struct Buckets {
    types: Vec<String>,
    relations: Vec<Relation>,
    queries: Vec<NamedQuery>,
    subscriptions: Vec<NamedSubscription>,
}

/// Sort one declaration link into the right collection.
///
/// Mirrors the JavaScript `collectDeclaration`.
fn collect_declaration(declaration: &Node, buckets: &mut Buckets) -> Result<()> {
    let Node::Link { values, .. } = declaration else {
        return Err(Error::Schema(
            "Each schema declaration must be a link".to_string(),
        ));
    };
    if values.is_empty() {
        return Err(Error::Schema(
            "Each schema declaration must be a link".to_string(),
        ));
    }
    let keyword = ref_name(values.first(), "declaration keyword")?;
    if !KEYWORDS.contains(&keyword.as_str()) {
        return Err(Error::Schema(format!(
            "Unknown schema declaration \"{keyword}\" (expected {})",
            KEYWORDS.join("|")
        )));
    }
    let rest = &values[1..];
    match keyword.as_str() {
        "type" => buckets.types.push(ref_name(rest.first(), "type name")?),
        "relation" => {
            let relation_name = ref_name(rest.first(), "relation name")?;
            let from = named_arg(rest, "from", &relation_name)?;
            let to = named_arg(rest, "to", &relation_name)?;
            buckets.relations.push(Relation {
                name: relation_name,
                from,
                to,
            });
        }
        "query" => buckets.queries.push(NamedQuery {
            name: ref_name(rest.first(), "query name")?,
            text: serialize_all(&rest[1..], " "),
        }),
        // The keyword set is closed, so anything reaching here is `subscription`.
        _ => buckets.subscriptions.push(NamedSubscription {
            name: ref_name(rest.first(), "subscription name")?,
            pattern: serialize_all(&rest[1..], " "),
        }),
    }
    Ok(())
}

/// Derive scalar type names: any relation endpoint not declared as an object
/// type, in first-seen order, deduped.
///
/// Mirrors the JavaScript `inferScalars`.
fn infer_scalars(relations: &[Relation], types: &[String]) -> Vec<String> {
    let mut scalars: Vec<String> = Vec::new();
    for relation in relations {
        for endpoint in [&relation.from, &relation.to] {
            if !types.contains(endpoint) && !scalars.contains(endpoint) {
                scalars.push(endpoint.clone());
            }
        }
    }
    scalars
}

impl Schema {
    /// Parse a schema written in Links Notation.
    ///
    /// # Examples
    ///
    /// ```
    /// use linksql::Schema;
    /// let schema = Schema::parse(
    ///     "(schema social\n  (type Person)\n  (type Post)\n  \
    ///      (relation name (from Person) (to Text))\n  \
    ///      (relation author (from Post) (to Person))\n  \
    ///      (relation likes (from Person) (to Post))\n  \
    ///      (query everyone (($p: $p $p)))\n  \
    ///      (subscription newLikes ((1 $post))))",
    /// )
    /// .unwrap();
    /// assert_eq!(schema.name.as_deref(), Some("social"));
    /// assert_eq!(schema.types, ["Person", "Post"]);
    /// assert_eq!(schema.scalars, ["Text"]);
    /// assert_eq!(schema.relation("author").unwrap().from, "Post");
    /// assert_eq!(schema.query("everyone").unwrap().text, "(($p: $p $p))");
    /// assert_eq!(schema.subscription("newLikes").unwrap().pattern, "((1 $post))");
    /// ```
    pub fn parse(text: &str) -> Result<Self> {
        let nodes = parse(text).map_err(|e| Error::Schema(format!("Invalid LiNo schema: {e}")))?;
        if nodes.len() != 1 || !matches!(nodes[0], Node::Link { .. }) {
            return Err(Error::Schema(
                "A schema must be a single `(schema ...)` link".to_string(),
            ));
        }
        let Node::Link { values, .. } = &nodes[0] else {
            unreachable!("checked to be a link above");
        };
        let mut rest = values.iter();
        let head = rest.next();
        match head {
            Some(Node::Ref(Ref::Name(name))) if name == "schema" => {}
            _ => {
                return Err(Error::Schema(
                    "A schema must start with the `schema` keyword".to_string(),
                ));
            }
        }
        let remaining: Vec<&Node> = rest.collect();

        // An optional bare name may follow the `schema` keyword.
        let mut name = None;
        let mut declarations = remaining.as_slice();
        if let Some((first, tail)) = remaining.split_first() {
            if matches!(first, Node::Ref(_)) {
                name = Some(ref_name(Some(first), "schema name")?);
                declarations = tail;
            }
        }

        let mut buckets = Buckets::default();
        for declaration in declarations {
            collect_declaration(declaration, &mut buckets)?;
        }
        let scalars = infer_scalars(&buckets.relations, &buckets.types);

        Ok(Self {
            name,
            types: buckets.types,
            scalars,
            relations: buckets.relations,
            queries: buckets.queries,
            subscriptions: buckets.subscriptions,
        })
    }

    /// Look up a relation by name.
    #[must_use]
    pub fn relation(&self, name: &str) -> Option<&Relation> {
        self.relations.iter().find(|relation| relation.name == name)
    }

    /// Look up a named query.
    #[must_use]
    pub fn query(&self, name: &str) -> Option<&NamedQuery> {
        self.queries.iter().find(|query| query.name == name)
    }

    /// Look up a named subscription.
    #[must_use]
    pub fn subscription(&self, name: &str) -> Option<&NamedSubscription> {
        self.subscriptions.iter().find(|sub| sub.name == name)
    }

    /// Whether a name is a declared type, scalar or relation.
    #[must_use]
    pub fn knows(&self, name: &str) -> bool {
        self.types.iter().any(|t| t == name)
            || self.scalars.iter().any(|s| s == name)
            || self.relations.iter().any(|relation| relation.name == name)
    }

    /// Assert that a relation is declared, returning an error otherwise.
    pub fn validate_relation(&self, name: &str) -> Result<&Relation> {
        self.relation(name)
            .ok_or_else(|| Error::Schema(format!("Unknown relation \"{name}\"")))
    }

    /// Render the schema back to canonical Links Notation.
    ///
    /// Type names are serialized through the LiNo serializer so quoting matches;
    /// relation, query and subscription parts reuse the stored strings, as the
    /// JavaScript reference does.
    #[must_use]
    pub fn to_lino(&self) -> String {
        let mut declarations: Vec<String> = Vec::new();
        for type_name in &self.types {
            let serialized = serialize(&Node::Ref(Ref::Name(type_name.clone())));
            declarations.push(format!("(type {serialized})"));
        }
        for relation in &self.relations {
            declarations.push(format!(
                "(relation {} (from {}) (to {}))",
                relation.name, relation.from, relation.to
            ));
        }
        for query in &self.queries {
            declarations.push(format!("(query {} {})", query.name, query.text));
        }
        for sub in &self.subscriptions {
            declarations.push(format!("(subscription {} {})", sub.name, sub.pattern));
        }
        let head = self
            .name
            .as_ref()
            .map_or_else(|| "schema".to_string(), |name| format!("schema {name}"));
        let mut parts = Vec::with_capacity(declarations.len() + 1);
        parts.push(head);
        parts.extend(declarations);
        format!("({})", parts.join(" "))
    }
}
