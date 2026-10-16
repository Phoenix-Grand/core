//! The vocabulary a module declares its storage under, and the two properties
//! the core derives from it: what is *billed* to the account, and what is
//! *held* by the declaring module.
//!
//! ## Why a closed vocabulary rather than free text
//!
//! The whole point of the breakdown is that the shares add up. A free-text
//! category lets `drive` write `"thumbs"` while `photos` writes `"thumbnails"`,
//! and the console then shows two slices of the same thing that no operator can
//! compare - and, worse, lets a module invent a category the core does not know
//! is billable, so the quota silently changes meaning. The list below is short,
//! technical, and refused at the door when a module strays outside it.
//!
//! ## THE BILLING CRITERION
//!
//! > **An account is billed for what it can free itself.**
//!
//! That is the whole rule, and it is sharper than "user content" because it is
//! decidable: point at the handle. Files, the bin and a revision history the
//! account can purge all have one - deleting, emptying, turning versioning off.
//! Thumbnails, search indexes, transcodes and upload chunks have none: the
//! account never asked for them, cannot enumerate them and cannot remove them,
//! so charging for them would be charging for a decision it did not make and
//! cannot unmake.
//!
//! The criterion has a sharp consequence, and it is deliberate: **the same word
//! can fall on either side depending on what the module lets the account do.**
//! `drive` exposes `DELETE /:id/versions/:vid` and a per-file versioning switch,
//! so its history is [`Category::Versions`] and billed. `office` keeps up to
//! `office.max_versions` revisions with no way to remove one, so its history is
//! [`Category::Retention`] and not billed. A module that wants its retention
//! billed does not relabel it - it gives the account a delete button.
//!
//! ## The two properties, and why they are separate
//!
//! * [`Category::is_billable`] - does this count against the account's quota?
//!   Answered by the criterion above.
//! * [`Category::is_held`] - does this count toward the physical volume
//!   attributed to the declaring module? Everything the module actually stores
//!   does, billable or not. Exactly one category is *not* held
//!   ([`Category::Delegated`]) - see its own note.
//!
//! Billed is therefore always a subset of held, and the console shows both: the
//! operator sizes a disk on `held`, the account is charged on `billable`.
//!
//! ## ⚠️ PRIVACY - the line this vocabulary exists to hold
//!
//! These identifiers are the ONLY thing an administrator ever learns about the
//! *shape* of what an account stores. A category is a technical role
//! ("thumbnails", "index"), never a subject, a document type, a file name, a
//! folder name or a path. Adding a category such as `photos`, `invoices`,
//! `medical` or `videos` would turn a capacity-planning page into a window on
//! someone's life, and is forbidden - however useful it would look on a chart.
//! The test `no_category_names_a_kind_of_content` guards the boundary.

use serde::{Deserialize, Serialize};

/// What a declared quantity of bytes *is*, in the module's own machinery.
///
/// Serialised as the lowercase identifier, which is also what travels on the
/// wire and what is stored in `core.storage_usage.category`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    /// What the account put there and sees: files it uploaded, documents it
    /// wrote. The default when a declaration omits the field, which is what
    /// keeps a module written against the first version of this channel
    /// correct rather than merely accepted.
    Content,

    /// Content the account deleted but can still restore. **Billed**, and kept
    /// as a category of its own precisely because it is billed: when an account
    /// saturates, "3 GiB of that is your bin" is the single most useful thing an
    /// operator can say, and the first thing to suggest before granting more
    /// room. Managing the bin is the account's own job - emptying it is its
    /// gesture and its decision - which is exactly the billing criterion, and
    /// charging for it is also the only thing that makes emptying it mean
    /// anything.
    Trash,

    /// Earlier revisions of the account's own documents, **which the account can
    /// purge**: turn versioning off, or delete a revision one at a time. Billed,
    /// by the criterion - there is a handle and the account holds it.
    ///
    /// A module whose history the account cannot reach must use
    /// [`Category::Retention`] instead. The distinction is not cosmetic: it is
    /// the difference between a cost somebody chose and a cost imposed on them.
    Versions,

    /// Copies the module keeps by its own policy and that the account has **no
    /// way to remove** - an automatic revision log with no delete, a journal
    /// pruned only by a counter in the module's settings.
    ///
    /// Not billed, by the criterion: there is no handle. This category exists to
    /// stop a module from quietly billing its retention policy under the name
    /// `versions`, and its presence on the console is a standing question -
    /// "why can nobody clear this?" - rather than a charge.
    Retention,

    /// Thumbnails, previews, poster frames. Not billed: derived renderings the
    /// module makes for its own display, regenerable from the content, and
    /// created without the account ever asking - drive generates one the first
    /// time a file is merely *looked at*.
    Thumbnails,

    /// Search indexes, extracted text, embeddings, perceptual hashes. Not
    /// billed: the module's own lookup structures.
    Index,

    /// Transcodes, remote-mount caches, memoised responses. Not billed: a cache
    /// is by definition something the module can throw away and rebuild.
    Cache,

    /// Work in progress: chunks of an upload that has not completed, scratch
    /// files. Not billed: it is not content until it lands, and a failed upload
    /// must not leave a charge behind.
    Staging,

    /// Resources the platform installs so the module can work - dictionaries,
    /// fonts, themes. They sit inside the account's tree for technical reasons
    /// but the account did not put them there and cannot meaningfully remove
    /// them. Not billed: this is the clearest case of "what the module needs in
    /// order to work well".
    System,

    /// Bytes this module caused to exist but that **another module physically
    /// holds** - the declaration that makes the attribution rule visible instead
    /// of merely respected.
    ///
    /// Neither billed nor held: the holder already declared these exact bytes,
    /// and adding them again is the double count this whole design exists to
    /// prevent. A module declares them so the console can say "office is behind
    /// 312 objects, weighed under drive" without those objects being counted
    /// twice. Declaring a non-zero `used_bytes` here is allowed and still never
    /// summed into any total.
    Delegated,
}

impl Category {
    /// Every category, in the order the console should show them: what the
    /// account is charged for first, then what it is not, then the pointer to
    /// another module's books.
    pub const ALL: &'static [Category] = &[
        Category::Content,
        Category::Trash,
        Category::Versions,
        Category::Retention,
        Category::Thumbnails,
        Category::Index,
        Category::Cache,
        Category::Staging,
        Category::System,
        Category::Delegated,
    ];

    /// The identifier on the wire and in the database.
    pub fn as_str(self) -> &'static str {
        match self {
            Category::Content => "content",
            Category::Trash => "trash",
            Category::Versions => "versions",
            Category::Retention => "retention",
            Category::Thumbnails => "thumbnails",
            Category::Index => "index",
            Category::Cache => "cache",
            Category::Staging => "staging",
            Category::System => "system",
            Category::Delegated => "delegated",
        }
    }

    /// Parses an identifier received from a module.
    ///
    /// Returns `None` rather than falling back to [`Category::Content`]: a
    /// module declaring a category the core does not know is a version skew, and
    /// silently billing its bytes as user content would be the worst possible
    /// guess.
    pub fn parse(s: &str) -> Option<Category> {
        Category::ALL.iter().copied().find(|c| c.as_str() == s)
    }

    /// Counts against `core.users.quota_bytes` - true exactly for the
    /// categories the account can free itself.
    pub fn is_billable(self) -> bool {
        matches!(self, Category::Content | Category::Trash | Category::Versions)
    }

    /// Counts toward the physical volume attributed to the declaring module.
    ///
    /// False for [`Category::Delegated`] alone - those bytes belong to another
    /// module's total and are already counted there.
    pub fn is_held(self) -> bool {
        !matches!(self, Category::Delegated)
    }
}

impl Default for Category {
    /// A declaration that names no category is user content. This is what makes
    /// the extension backwards compatible: the original channel carried exactly
    /// one kind of bytes, and it was this one.
    fn default() -> Self {
        Category::Content
    }
}

impl std::fmt::Display for Category {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The vocabulary as data, for the administration console: it renders the
/// categories it is told about rather than a list compiled into the frontend, so
/// adding one here makes it appear there.
#[derive(Debug, Clone, Serialize)]
pub struct CategoryInfo {
    pub id: &'static str,
    pub billable: bool,
    pub held: bool,
}

/// Describes every category, in display order.
pub fn catalog() -> Vec<CategoryInfo> {
    Category::ALL
        .iter()
        .map(|c| CategoryInfo {
            id: c.as_str(),
            billable: c.is_billable(),
            held: c.is_held(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_identifier_round_trips() {
        for c in Category::ALL {
            assert_eq!(Category::parse(c.as_str()), Some(*c), "{c}");
        }
    }

    #[test]
    fn an_unknown_category_is_refused_rather_than_guessed() {
        // Falling back to Content would bill an account for bytes whose nature
        // the core does not understand.
        assert_eq!(Category::parse("thumbs"), None);
        assert_eq!(Category::parse(""), None);
        assert_eq!(Category::parse("CONTENT"), None);
    }

    #[test]
    fn omitting_the_category_means_user_content() {
        assert_eq!(Category::default(), Category::Content);
    }

    #[test]
    fn only_what_the_account_can_free_is_billed() {
        // Files it can delete, a bin it can empty, a history it can purge.
        assert!(Category::Content.is_billable());
        assert!(Category::Trash.is_billable());
        assert!(Category::Versions.is_billable());
        // Everything the account never asked for and cannot remove.
        for c in Category::ALL.iter().filter(|c| {
            !matches!(c, Category::Content | Category::Trash | Category::Versions)
        }) {
            assert!(!c.is_billable(), "{c} must not be billed: the account has no handle on it");
        }
    }

    /// The criterion is decidable, so the two revision categories must land on
    /// opposite sides - otherwise the distinction between a history somebody
    /// chose and one imposed on them has no effect anywhere.
    #[test]
    fn a_purgeable_history_is_billed_and_an_imposed_one_is_not() {
        assert!(Category::Versions.is_billable());
        assert!(!Category::Retention.is_billable());
        assert!(Category::Retention.is_held(), "it is still on the disk");
    }

    #[test]
    fn billed_is_always_a_subset_of_held() {
        for c in Category::ALL {
            if c.is_billable() {
                assert!(c.is_held(), "{c} is billed but not held - the totals cannot add up");
            }
        }
    }

    #[test]
    fn delegated_is_the_only_category_another_module_holds() {
        let not_held: Vec<_> = Category::ALL.iter().filter(|c| !c.is_held()).collect();
        assert_eq!(not_held, vec![&Category::Delegated]);
    }

    /// ⚠️ PRIVACY GUARD. A category names a technical role in the module's
    /// machinery, never a kind of content. If this test has to be edited to add
    /// a category, the category is the thing that is wrong.
    #[test]
    fn no_category_names_a_kind_of_content() {
        const FORBIDDEN: &[&str] = &[
            "photo", "photos", "video", "videos", "music", "audio", "document",
            "documents", "invoice", "invoices", "medical", "health", "mail",
            "message", "messages", "contact", "contacts", "note", "notes",
            "picture", "pictures", "image", "images", "book", "books",
        ];
        for c in Category::ALL {
            let id = c.as_str();
            assert!(
                !FORBIDDEN.contains(&id),
                "category `{id}` describes what a person stores, not how the module stores it"
            );
        }
    }
}
