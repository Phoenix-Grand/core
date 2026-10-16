/// Rôles disponibles dans le système.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Role {
    Guest,
    User,
    Admin,
}

impl Role {
    /// Not `FromStr`: that trait is fallible and this mapping is not - an
    /// unknown string is a plain user, never an error. Naming it `from_str`
    /// invited the confusion clippy points at, and a caller reaching for `?` on
    /// it would not compile for a reason nobody would enjoy diagnosing.
    pub fn parse(s: &str) -> Self {
        match s {
            "admin" => Role::Admin,
            "guest" => Role::Guest,
            _ => Role::User,
        }
    }

    pub fn can_admin(&self) -> bool {
        *self == Role::Admin
    }
}
