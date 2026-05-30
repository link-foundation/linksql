//! In-memory doublets store.
//!
//! The associative data model used by LinksQL is built from a single primitive:
//! the **link** (a doublet). Every link is a triple
//!
//! ```text
//! (index: source target)
//! ```
//!
//! where `index` is the link's own unique identity and `source`/`target` are the
//! indices of the linked links. A link whose source and target both equal its
//! own index is a *point* — the atomic node of the graph.
//!
//! The store owns identity allocation and enforces the associative invariant
//! that a `(source, target)` pair identifies at most one link (deduplication).
//! It is a pure data container: pattern matching and the substitution operation
//! live in [`crate::substitution`], which only relies on the read/write surface
//! defined here.

use crate::{Error, Result};
use std::collections::HashMap;

/// A link (doublet): a triple of integer identities.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Link {
    /// The link's own unique identity.
    pub index: i64,
    /// The index this link points from.
    pub source: i64,
    /// The index this link points to.
    pub target: i64,
}

/// A mutable set of links addressed by integer identity.
///
/// Insertion order is preserved by [`LinksStore::all`] (matching the JavaScript
/// `Map` iteration order) via a parallel order list; links are *not* sorted by
/// index.
#[derive(Debug, Default, Clone)]
pub struct LinksStore {
    /// Identity → link.
    links: HashMap<i64, Link>,
    /// Insertion order of identities (mirrors JS `Map` key order).
    order: Vec<i64>,
    /// `(source, target)` → identity, for structural deduplication.
    by_pair: HashMap<(i64, i64), i64>,
    /// Next identity to hand out; kept above every used index.
    next_index: i64,
}

impl LinksStore {
    /// Create an empty store with the allocator starting at `1`.
    #[must_use]
    pub fn new() -> Self {
        Self {
            links: HashMap::new(),
            order: Vec::new(),
            by_pair: HashMap::new(),
            next_index: 1,
        }
    }

    /// Number of stored links.
    #[must_use]
    pub fn size(&self) -> usize {
        self.links.len()
    }

    /// Whether a link with this identity exists.
    #[must_use]
    pub fn has(&self, index: i64) -> bool {
        self.links.contains_key(&index)
    }

    /// Fetch a link by identity.
    #[must_use]
    pub fn get(&self, index: i64) -> Option<Link> {
        self.links.get(&index).copied()
    }

    /// Look up a link by its `(source, target)` structure.
    #[must_use]
    pub fn find_by_pair(&self, source: i64, target: i64) -> Option<Link> {
        self.by_pair
            .get(&(source, target))
            .and_then(|index| self.links.get(index).copied())
    }

    /// All links, in insertion order.
    #[must_use]
    pub fn all(&self) -> Vec<Link> {
        self.order.iter().map(|index| self.links[index]).collect()
    }

    /// Reserve a fresh identity, advancing the allocator past it.
    pub fn allocate_index(&mut self) -> i64 {
        while self.links.contains_key(&self.next_index) {
            self.next_index += 1;
        }
        let id = self.next_index;
        self.next_index += 1;
        id
    }

    /// Keep the allocator above an externally chosen identity.
    pub const fn reserve_index(&mut self, index: i64) {
        if index >= self.next_index {
            self.next_index = index + 1;
        }
    }

    /// Insert a link, recording insertion order and the pair index.
    fn insert(&mut self, link: Link) {
        self.links.insert(link.index, link);
        self.order.push(link.index);
        self.by_pair.insert((link.source, link.target), link.index);
    }

    /// Remove a link from the maps and the order list.
    fn remove(&mut self, index: i64) -> Option<Link> {
        let link = self.links.remove(&index)?;
        self.by_pair.remove(&(link.source, link.target));
        if let Some(pos) = self.order.iter().position(|&i| i == index) {
            self.order.remove(pos);
        }
        Some(link)
    }

    /// Create (or, by deduplication, return) a link.
    ///
    /// If `(source, target)` already exists, the existing link is returned (and a
    /// conflicting explicit `index` is an error). Otherwise the explicit `index`
    /// is used (it MUST be `>= 1` and unused) or a fresh one is allocated.
    pub fn create(&mut self, index: Option<i64>, source: i64, target: i64) -> Result<Link> {
        if let Some(existing) = self.find_by_pair(source, target) {
            if let Some(idx) = index {
                if idx != existing.index {
                    return Err(Error::LinkIntegrity(format!(
                        "Link ({source} {target}) already exists as {}, cannot also be {idx}",
                        existing.index
                    )));
                }
            }
            return Ok(existing);
        }
        let id = match index {
            None => self.allocate_index(),
            Some(idx) => {
                if idx < 1 {
                    return Err(Error::LinkIntegrity(
                        "Link index must be a positive integer".to_string(),
                    ));
                }
                if self.links.contains_key(&idx) {
                    return Err(Error::LinkIntegrity(format!(
                        "Link index {idx} is already in use"
                    )));
                }
                self.reserve_index(idx);
                idx
            }
        };
        let link = Link {
            index: id,
            source,
            target,
        };
        self.insert(link);
        Ok(link)
    }

    /// Replace the structure of an existing link, preserving its identity unless
    /// a new identity is requested.
    ///
    /// Errors if the link is missing, if the new `(source, target)` collides with
    /// a *different* link, or if a requested `new_index` is already in use.
    pub fn update(
        &mut self,
        index: i64,
        source: i64,
        target: i64,
        new_index: Option<i64>,
    ) -> Result<Link> {
        let Some(current) = self.links.get(&index).copied() else {
            return Err(Error::LinkIntegrity(format!(
                "Cannot update missing link {index}"
            )));
        };
        let id = new_index.unwrap_or(index);
        if let Some(collision) = self.find_by_pair(source, target) {
            if collision.index != index {
                return Err(Error::LinkIntegrity(format!(
                    "Cannot update link {index}: ({source} {target}) already exists as {}",
                    collision.index
                )));
            }
        }
        if id != index && self.links.contains_key(&id) {
            return Err(Error::LinkIntegrity(format!(
                "Link index {id} is already in use"
            )));
        }
        // Mirror the JavaScript `Map` semantics exactly: delete the old key then
        // set the new one. In JS, `map.delete(k); map.set(k, v)` re-appends the
        // entry even when the key is unchanged, so `update` always moves the link
        // to the end of iteration order.
        self.by_pair.remove(&(current.source, current.target));
        if let Some(pos) = self.order.iter().position(|&i| i == index) {
            self.order.remove(pos);
        }
        self.links.remove(&index);
        let link = Link {
            index: id,
            source,
            target,
        };
        self.links.insert(id, link);
        self.order.push(id);
        self.by_pair.insert((source, target), id);
        self.reserve_index(id);
        Ok(link)
    }

    /// Remove a link by identity. Returns whether a link was removed.
    pub fn delete(&mut self, index: i64) -> bool {
        self.remove(index).is_some()
    }

    /// Remove every link and reset identity allocation.
    pub fn clear(&mut self) {
        self.links.clear();
        self.order.clear();
        self.by_pair.clear();
        self.next_index = 1;
    }
}
