//! The shapes a campaign is made of, and the two rules that keep them honest:
//! a service names the module that will do the work, and a credential never
//! travels outward.

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::errors::AppError;

/// A service that can be migrated.
///
/// One variant per service, and each names the module that owns the
/// destination. This is the *only* place in the core where a module id appears
/// for this feature, and it is a declaration rather than a coupling: the
/// console offers a service only when that module is currently registered
/// (`store::available_services`), so an instance without the module never sees
/// the option and never opens a campaign nothing would pick up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceKind {
    /// Mailboxes, read from an IMAP server.
    Mail,
}

impl ServiceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ServiceKind::Mail => "mail",
        }
    }

    /// The module asked to perform the copy.
    pub fn module_id(self) -> &'static str {
        match self {
            ServiceKind::Mail => "mail",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, AppError> {
        match raw {
            "mail" => Ok(ServiceKind::Mail),
            other => Err(AppError::Validation(format!(
                "Service de migration inconnu : « {other} »"
            ))),
        }
    }

    /// Every service the core knows how to orchestrate, installed or not.
    pub const ALL: &'static [ServiceKind] = &[ServiceKind::Mail];
}

/// How to reach the source server. Never carries the password: that belongs to
/// one mapped account, not to the campaign (see the migration's header).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceSpec {
    pub kind:     String,
    pub host:     String,
    pub port:     i32,
    pub security: String,
}

impl SourceSpec {
    /// Rejects anything the module would have to reject anyway, here, before a
    /// row is written or a socket opened.
    pub fn validate(&self) -> Result<(), AppError> {
        if self.kind != "imap" {
            return Err(AppError::Validation(
                "Type de serveur source non pris en charge (attendu : imap).".into(),
            ));
        }
        let host = self.host.trim();
        if host.is_empty() || host.len() > 255 {
            return Err(AppError::Validation(
                "Adresse du serveur source manquante ou trop longue.".into(),
            ));
        }
        // A host is a name or an address, never a URL: accepting
        // "imaps://server/path" here would produce a connection error hours
        // later, at the first chunk, with nothing to point at.
        if host.contains('/') || host.contains(' ') || host.contains(':') {
            return Err(AppError::Validation(
                "Adresse du serveur source invalide : indiquez un nom d'hôte, sans schéma ni port.".into(),
            ));
        }
        if !(1..=65535).contains(&self.port) {
            return Err(AppError::Validation("Port du serveur source invalide.".into()));
        }
        match self.security.as_str() {
            // Refused, and this is not an oversight. The pilot module's IMAP
            // client negotiates TLS for `ssl` and opens a plain socket for
            // everything else - it sends no STARTTLS command. Accepting the
            // value would show an administrator a control that says "chiffré"
            // and hand an entire organisation's passwords to the network in
            // clear. A missing option is a limitation; this one would be a lie.
            "starttls" => Err(AppError::Validation(
                "STARTTLS n'est pas pris en charge pour la migration : \
                 utilisez une connexion SSL/TLS (port 993 en général)."
                    .into(),
            )),
            // Allowed because it claims nothing: an operator choosing it knows
            // the session is not encrypted.
            "ssl" | "none" => Ok(()),
            _ => Err(AppError::Validation(
                "Méthode de connexion invalide (attendu : ssl ou none).".into(),
            )),
        }
    }
}

/// A campaign, as the console reads it. No credential appears in this struct,
/// which is why it can be serialised straight into a response.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Campaign {
    pub id:              Uuid,
    pub name:            String,
    pub service:         String,
    pub module_id:       String,
    pub source_kind:     String,
    pub source_host:     String,
    pub source_port:     i32,
    pub source_security: String,
    pub since_date:      Option<NaiveDate>,
    // PostgreSQL `TEXT[]` today; read as a JSON array (portable) - the column is
    // migrated `TEXT[]` → `JSONB` on the schema-consolidation side.
    #[sqlx(json)]
    pub exclude_folders: Vec<String>,
    pub status:          String,
    pub created_by:      Option<Uuid>,
    pub actor_label:     Option<String>,
    pub created_at:      DateTime<Utc>,
    pub started_at:      Option<DateTime<Utc>>,
    pub finished_at:     Option<DateTime<Utc>>,
    pub error:           Option<String>,
}

impl Campaign {
    pub fn source(&self) -> SourceSpec {
        SourceSpec {
            kind:     self.source_kind.clone(),
            host:     self.source_host.clone(),
            port:     self.source_port,
            security: self.source_security.clone(),
        }
    }
}

/// One mapped account and its progress.
///
/// `secret_enc` is **not** a field: every read of this table enumerates its
/// columns and leaves the credential behind, so a struct that cannot hold it
/// cannot leak it into a response by accident.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct MigrationAccount {
    pub id:             Uuid,
    pub campaign_id:    Uuid,
    pub source_login:   String,
    pub target_user_id: Uuid,
    /// Resolved for the console, so a row can name the destination without a
    /// second request.
    pub target_email:   Option<String>,
    pub target_name:    Option<String>,
    pub status:         String,
    pub items_copied:   i32,
    pub items_total:    i32,
    pub attempts:       i32,
    pub error:          Option<String>,
    pub started_at:     Option<DateTime<Utc>>,
    pub finished_at:    Option<DateTime<Utc>>,
    pub updated_at:     DateTime<Utc>,
}

/// What the console counts on a campaign row.
#[derive(Debug, Clone, Default, Serialize)]
pub struct CampaignTally {
    pub accounts: i64,
    pub pending:  i64,
    pub running:  i64,
    pub done:     i64,
    pub failed:   i64,
    pub copied:   i64,
    pub total:    i64,
}

/// One mapping as the console submits it, credential included - the only shape
/// in this module that carries a password, and it exists for the length of one
/// request.
///
/// Deliberately not `Debug`: a derived `Debug` is how a password ends up in a
/// panic message or a `tracing` field that nobody meant to add.
#[derive(Deserialize)]
pub struct AccountMappingInput {
    pub source_login:   String,
    pub password:       String,
    pub target_user_id: Uuid,
}

impl AccountMappingInput {
    pub fn validate(&self) -> Result<(), AppError> {
        let login = self.source_login.trim();
        if login.is_empty() || login.len() > 320 {
            return Err(AppError::Validation(
                "Identifiant du compte source manquant ou trop long.".into(),
            ));
        }
        if self.password.is_empty() {
            return Err(AppError::Validation(format!(
                "Mot de passe manquant pour le compte source « {login} »."
            )));
        }
        if self.password.len() > 1024 {
            return Err(AppError::Validation(
                "Mot de passe du compte source trop long.".into(),
            ));
        }
        Ok(())
    }
}

/// Upper bound on a single campaign. Not a limit of the machinery - the job
/// walks any number of rows - but of one *request*: a console that posts ten
/// thousand mappings in one body is a mistake, and finding out through a
/// timeout is worse than finding out through a message.
pub const MAX_ACCOUNTS_PER_CAMPAIGN: usize = 2000;

/// Folders excluded, as submitted.
pub fn validate_exclusions(folders: &[String]) -> Result<(), AppError> {
    if folders.len() > 200 {
        return Err(AppError::Validation(
            "Trop de dossiers exclus (200 au maximum).".into(),
        ));
    }
    if folders.iter().any(|f| f.len() > 500) {
        return Err(AppError::Validation("Nom de dossier exclu trop long.".into()));
    }
    Ok(())
}
