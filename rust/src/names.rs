//! Named references.
//!
//! Link indices are convenient for machines but opaque to humans. A [`Names`]
//! registry maps human-readable labels to link identities (mirroring the sidecar
//! `<db>.names.links` file used by link-cli) so a query can say
//! `(alice loves bob)` instead of `(7 9 8)`.
//!
//! A freshly-named identity is materialised as a *point* — the link `(i: i i)` —
//! so that everything in the model remains a link. When `auto_create` is
//! disabled, referring to an unknown name is an error instead, which is useful
//! for catching typos in production schemas.
//!
//! Unlike the JavaScript [`Names`], which stores a reference to its backing
//! store, this Rust port takes the [`LinksStore`] as an explicit `&mut`
//! parameter on the methods that mutate it ([`Names::ensure`], [`Names::bind`]),
//! to keep within Rust's borrow rules.

use crate::store::LinksStore;
use crate::{Error, Result};
use std::collections::HashMap;

/// A bidirectional registry of label ↔ link-index associations.
#[derive(Debug, Clone)]
pub struct Names {
    /// Whether unknown names are allocated on demand.
    pub auto_create: bool,
    /// Label → index.
    by_name: HashMap<String, i64>,
    /// Index → label.
    by_index: HashMap<i64, String>,
    /// Insertion order of names (mirrors JS `Map` key order for `entries`).
    order: Vec<String>,
}

impl Names {
    /// Create a registry with the given auto-create behaviour.
    #[must_use]
    pub fn new(auto_create: bool) -> Self {
        Self {
            auto_create,
            by_name: HashMap::new(),
            by_index: HashMap::new(),
            order: Vec::new(),
        }
    }

    /// Resolve a name to its index without creating anything.
    #[must_use]
    pub fn resolve(&self, name: &str) -> Option<i64> {
        self.by_name.get(name).copied()
    }

    /// Resolve a name, allocating and materialising it when permitted.
    ///
    /// Known names return their bound index. An unknown name errors when
    /// `auto_create` is disabled; otherwise a fresh index is allocated, the name
    /// is bound, and the index is materialised as a point `(i: i i)` if absent.
    pub fn ensure(&mut self, store: &mut LinksStore, name: &str) -> Result<i64> {
        if let Some(existing) = self.by_name.get(name) {
            return Ok(*existing);
        }
        if !self.auto_create {
            return Err(Error::UnknownName(name.to_string()));
        }
        let index = store.allocate_index();
        self.bind(store, name, index);
        if !store.has(index) {
            store.create(Some(index), index, index)?;
        }
        Ok(index)
    }

    /// Associate a name with an existing index (no materialisation).
    pub fn bind(&mut self, store: &mut LinksStore, name: &str, index: i64) -> i64 {
        if !self.by_name.contains_key(name) {
            self.order.push(name.to_string());
        }
        self.by_name.insert(name.to_string(), index);
        self.by_index.insert(index, name.to_string());
        store.reserve_index(index);
        index
    }

    /// Look up the label associated with an index.
    #[must_use]
    pub fn name_of(&self, index: i64) -> Option<&str> {
        self.by_index.get(&index).map(String::as_str)
    }

    /// All `(name, index)` associations, in insertion order.
    #[must_use]
    pub fn entries(&self) -> Vec<(String, i64)> {
        self.order
            .iter()
            .map(|name| (name.clone(), self.by_name[name]))
            .collect()
    }

    /// Remove every name association (used by [`crate::query::Database::clear`]).
    pub fn clear(&mut self) {
        self.by_name.clear();
        self.by_index.clear();
        self.order.clear();
    }
}
