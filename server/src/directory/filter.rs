//! Building the search filter that finds one person, without letting what they
//! typed become part of the query's structure.
//!
//! An LDAP filter is an expression, and `(uid={login})` with `{login}` replaced
//! verbatim is the LDAP equivalent of string-concatenated SQL: typing
//! `*)(objectClass=*` turns "find this person" into "find everybody", and the
//! first entry returned is bound against. RFC 4515 §3 lists the five characters
//! that must be escaped for that not to happen, and [`escape_value`] is the only
//! way a value enters a filter in this module.

/// Placeholder an operator writes in `user_filter`.
pub const LOGIN_PLACEHOLDER: &str = "{login}";

/// Longest login accepted into a filter. A directory `uid` is short by nature;
/// this bounds what a stranger at the sign-in form can make the server build.
pub const MAX_LOGIN_LEN: usize = 256;

/// Escapes a value for inclusion in a filter (RFC 4515 §3).
///
/// The NUL byte is in the list because the wire format is length-prefixed and a
/// NUL is a perfectly transportable byte - dropping it silently would let two
/// different logins produce the same query.
pub fn escape_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\5c"),
            '*' => out.push_str("\\2a"),
            '(' => out.push_str("\\28"),
            ')' => out.push_str("\\29"),
            '\0' => out.push_str("\\00"),
            other => out.push(other),
        }
    }
    out
}

/// Escapes a value destined for a DN component (RFC 4514 §2.4).
///
/// Used when a group's `member` attribute has to be compared against a person's
/// distinguished name inside a filter: the DN is itself a value there, so both
/// escapings apply, in this order.
pub fn escape_dn_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for (i, c) in value.chars().enumerate() {
        let leading = i == 0;
        let trailing = i + 1 == value.chars().count();
        match c {
            '\\' | ',' | '+' | '"' | '<' | '>' | ';' | '=' => {
                out.push('\\');
                out.push(c);
            }
            '#' if leading => out.push_str("\\#"),
            ' ' if leading || trailing => out.push_str("\\ "),
            '\0' => out.push_str("\\00"),
            other => out.push(other),
        }
    }
    out
}

/// Why a login was refused before it ever reached the directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterError {
    /// Nothing was typed.
    EmptyLogin,
    /// Longer than [`MAX_LOGIN_LEN`].
    LoginTooLong,
    /// The configured template has no `{login}` in it, so every sign-in would
    /// run the same query and bind against whoever came back first.
    NoPlaceholder,
    /// The template is blank.
    EmptyTemplate,
}

impl FilterError {
    /// Operator-facing wording. Never shown on the sign-in path - a stranger
    /// gets the same "invalid credentials" as everybody else - only in the
    /// administration console and in the logs.
    pub const fn message(self) -> &'static str {
        match self {
            Self::EmptyLogin => "Identifiant vide",
            Self::LoginTooLong => "Identifiant trop long",
            Self::NoPlaceholder => "Le filtre de recherche ne contient pas « {login} »",
            Self::EmptyTemplate => "Filtre de recherche vide",
        }
    }
}

/// Substitutes the login into the operator's template, escaped.
///
/// Refusing a template without `{login}` is not pedantry: `(objectClass=person)`
/// is a syntactically valid filter that matches everybody, and a search-then-bind
/// that starts from it authenticates the first person in the tree against
/// whatever password was typed.
pub fn build_user_filter(template: &str, login: &str) -> Result<String, FilterError> {
    let template = template.trim();
    if template.is_empty() {
        return Err(FilterError::EmptyTemplate);
    }
    if !template.contains(LOGIN_PLACEHOLDER) {
        return Err(FilterError::NoPlaceholder);
    }
    let login = login.trim();
    if login.is_empty() {
        return Err(FilterError::EmptyLogin);
    }
    if login.chars().count() > MAX_LOGIN_LEN {
        return Err(FilterError::LoginTooLong);
    }
    Ok(template.replace(LOGIN_PLACEHOLDER, &escape_value(login)))
}

/// The filter listing everybody a synchronisation should import.
///
/// The same template, with the placeholder widened to `*` - which is why the
/// placeholder is substituted rather than removed: `(uid=*)` still says "an
/// entry that has a uid", and an operator's extra clauses (`objectClass`,
/// `!(userAccountControl…)`) are preserved exactly as they wrote them.
pub fn build_sync_filter(template: &str) -> Result<String, FilterError> {
    let template = template.trim();
    if template.is_empty() {
        return Err(FilterError::EmptyTemplate);
    }
    if !template.contains(LOGIN_PLACEHOLDER) {
        return Err(FilterError::NoPlaceholder);
    }
    Ok(template.replace(LOGIN_PLACEHOLDER, "*"))
}

/// The filter listing the groups a person belongs to, when membership is read
/// from the group side (`member` / `uniqueMember`) rather than from the
/// person's own entry.
pub fn build_group_membership_filter(
    group_filter: &str,
    member_attr: &str,
    user_dn: &str,
) -> String {
    let base = group_filter.trim();
    let clause = format!("({}={})", member_attr, escape_value(user_dn));
    if base.is_empty() {
        clause
    } else {
        format!("(&{base}{clause})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_five_special_characters_are_escaped() {
        assert_eq!(escape_value("a*b"), "a\\2ab");
        assert_eq!(escape_value("a(b)c"), "a\\28b\\29c");
        assert_eq!(escape_value("a\\b"), "a\\5cb");
        assert_eq!(escape_value("a\0b"), "a\\00b");
        // Everything else is left exactly as typed, accents included.
        assert_eq!(escape_value("jean.dupré"), "jean.dupré");
    }

    #[test]
    fn an_injected_filter_stays_a_value() {
        // The attack: close the clause, add one of your own, leave the rest
        // dangling. Escaped, it is a login nobody has rather than a query.
        let injected = "*)(objectClass=*";
        let filter = build_user_filter("(&(objectClass=inetOrgPerson)(uid={login}))", injected)
            .expect("filtre construit");
        assert_eq!(
            filter,
            "(&(objectClass=inetOrgPerson)(uid=\\2a\\29\\28objectClass=\\2a))"
        );
        // The structure of the query is untouched: same parenthesis count as
        // the template, and no clause was added.
        assert_eq!(filter.matches("(objectClass=").count(), 1);
    }

    #[test]
    fn a_template_without_the_placeholder_is_refused() {
        // `(objectClass=person)` matches everybody. A search-then-bind starting
        // from it signs the first entry in the tree in with any password.
        assert_eq!(
            build_user_filter("(objectClass=person)", "alice"),
            Err(FilterError::NoPlaceholder)
        );
        assert_eq!(build_user_filter("", "alice"), Err(FilterError::EmptyTemplate));
    }

    #[test]
    fn an_empty_or_oversized_login_never_reaches_the_directory() {
        assert_eq!(build_user_filter("(uid={login})", ""), Err(FilterError::EmptyLogin));
        assert_eq!(build_user_filter("(uid={login})", "   "), Err(FilterError::EmptyLogin));
        let long = "a".repeat(MAX_LOGIN_LEN + 1);
        assert_eq!(
            build_user_filter("(uid={login})", &long),
            Err(FilterError::LoginTooLong)
        );
    }

    #[test]
    fn the_placeholder_appears_more_than_once_when_the_operator_wrote_it_twice() {
        // Common in practice: accept either the login or the address.
        let filter = build_user_filter("(|(uid={login})(mail={login}))", "alice")
            .expect("filtre construit");
        assert_eq!(filter, "(|(uid=alice)(mail=alice))");
    }

    #[test]
    fn the_sync_filter_keeps_the_operators_own_clauses() {
        let filter = build_sync_filter(
            "(&(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(sAMAccountName={login}))",
        )
        .expect("filtre construit");
        assert_eq!(
            filter,
            "(&(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(sAMAccountName=*))"
        );
    }

    #[test]
    fn a_membership_filter_escapes_the_distinguished_name() {
        let f = build_group_membership_filter(
            "(objectClass=groupOfNames)",
            "member",
            "cn=Ali (test),ou=gens,dc=x",
        );
        assert_eq!(
            f,
            "(&(objectClass=groupOfNames)(member=cn=Ali \\28test\\29,ou=gens,dc=x))"
        );
    }

    #[test]
    fn dn_values_escape_the_rfc_4514_set() {
        assert_eq!(escape_dn_value("Dupont, Jean"), "Dupont\\, Jean");
        // A leading or trailing space is escaped, not doubled.
        assert_eq!(escape_dn_value(" bord"), "\\ bord");
        assert_eq!(escape_dn_value("bord "), "bord\\ ");
        assert_eq!(escape_dn_value("#tag"), "\\#tag");
    }
}
