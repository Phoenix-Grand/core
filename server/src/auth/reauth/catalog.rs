//! Which actions demand a fresh proof of presence.
//!
//! ## Why the list lives here, for now
//!
//! The delegated-privilege model being built alongside this work owns the real
//! catalogue: privileges, who holds them, and a `sensitive` flag on each. The
//! step-up mechanism must not wait for it, so this file holds a small, explicit
//! list of the actions the core already exposes that no one should be able to
//! perform on a twenty-minute-old access token left open in a tab.
//!
//! ## How to hand this over to the privilege catalogue
//!
//! Every entry carries a [`SensitiveAction::privilege`] key written in the
//! privilege model's own naming (`<subject>.<verb>`). Wiring the two together is
//! then a three-step change, and nothing outside this file moves:
//!
//! 1. replace the body of [`is_sensitive`] with a lookup of the privilege
//!    required by the matched route, followed by a read of that privilege's
//!    `sensitive` flag in the catalogue (cached like `crate::auth::ddos` does,
//!    so the extractor stays one round-trip);
//! 2. delete [`SENSITIVE_ACTIONS`] - the flag in the catalogue becomes the single
//!    source of truth, and this table stops being a second place to forget;
//! 3. keep [`Reauthenticated`](super::guard::Reauthenticated) exactly as it is:
//!    the extractor asks "is this sensitive?" and never how the answer is found.
//!
//! Until then, both can coexist: an action is sensitive if the catalogue says so
//! **or** if it appears below.

/// One action that requires a fresh proof.
#[derive(Debug, Clone, Copy)]
pub struct SensitiveAction {
    /// HTTP method, or `"*"` for any.
    pub method: &'static str,
    /// Path under `/api/v1`, with `:param` segments.
    pub path: &'static str,
    /// Key in the delegated-privilege model's naming, for the hand-over above.
    pub privilege: &'static str,
    /// Shown to the operator in the re-authentication dialog.
    pub label: &'static str,
}

/// The core's own sensitive actions.
///
/// Kept short on purpose. An action belongs here when performing it with a stolen
/// tab would hand over durable control: minting a long-lived credential, removing
/// the second factor, or reprinting the codes that bypass it.
pub const SENSITIVE_ACTIONS: &[SensitiveAction] = &[
    SensitiveAction {
        method: "POST",
        path: "/me/api-tokens",
        privilege: "api_tokens.create",
        label: "Create an API token",
    },
    SensitiveAction {
        method: "DELETE",
        path: "/me/2fa",
        privilege: "security.two_factor.disable",
        label: "Disable two-factor authentication",
    },
    SensitiveAction {
        method: "POST",
        path: "/me/2fa/backup-codes",
        privilege: "security.backup_codes.regenerate",
        label: "Regenerate backup codes",
    },
];

/// Matches a request path against a pattern containing `:param` segments.
fn path_matches(pattern: &str, path: &str) -> bool {
    let mut p = pattern.split('/');
    let mut a = path.split('/');
    loop {
        match (p.next(), a.next()) {
            (None, None) => return true,
            (Some(seg), Some(actual)) => {
                if seg.starts_with(':') {
                    if actual.is_empty() {
                        return false;
                    }
                } else if seg != actual {
                    return false;
                }
            }
            _ => return false,
        }
    }
}

/// The sensitive action a request targets, if any.
///
/// `path` is expected without the `/api/v1` prefix; the prefix is tolerated so
/// callers can pass either form.
pub fn is_sensitive(method: &str, path: &str) -> Option<&'static SensitiveAction> {
    let path = path.strip_prefix("/api/v1").unwrap_or(path);
    let path = path.strip_suffix('/').unwrap_or(path);
    SENSITIVE_ACTIONS.iter().find(|a| {
        (a.method == "*" || a.method.eq_ignore_ascii_case(method)) && path_matches(a.path, path)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_listed_action_is_recognised_with_or_without_the_api_prefix() {
        assert!(is_sensitive("POST", "/me/api-tokens").is_some());
        assert!(is_sensitive("POST", "/api/v1/me/api-tokens").is_some());
        assert!(is_sensitive("post", "/me/api-tokens").is_some());
    }

    #[test]
    fn the_method_is_part_of_the_match() {
        assert!(is_sensitive("GET", "/me/api-tokens").is_none());
        assert!(is_sensitive("DELETE", "/me/2fa").is_some());
        assert!(is_sensitive("GET", "/me/2fa").is_none());
    }

    #[test]
    fn an_unlisted_route_is_not_sensitive() {
        assert!(is_sensitive("PATCH", "/me").is_none());
        assert!(is_sensitive("GET", "/admin/users").is_none());
    }

    #[test]
    fn parameter_segments_match_one_segment_only() {
        assert!(path_matches("/me/api-tokens/:id", "/me/api-tokens/42"));
        assert!(!path_matches("/me/api-tokens/:id", "/me/api-tokens"));
        assert!(!path_matches("/me/api-tokens/:id", "/me/api-tokens/42/extra"));
    }
}
