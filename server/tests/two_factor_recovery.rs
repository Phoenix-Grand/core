//! Backup codes, step-up re-authentication and the administrator requirement,
//! exercised against a real PostgreSQL.
//!
//! These are the properties the whole feature rests on, and none of them can be
//! checked without a database: single use is enforced by an `UPDATE … WHERE
//! used_at IS NULL`, regeneration by a `DELETE`, revocation by a row that stops
//! existing. Asserting them in isolation would only test the mock.
//!
//! Needs `KUBUNO_TEST_DATABASE_URL` (see `tests/common`). Without it every test
//! prints a notice and passes - a CI with no PostgreSQL must not turn red on a
//! missing fixture.

mod common;

use chrono::{Duration as ChronoDuration, Utc};
use kubuno_core::auth::{
    admin_2fa, backup_codes,
    reauth::{claims, store},
};
use kubuno_core::models::user::User;
use kubuno_db::{params, DbPool};
use uuid::Uuid;

const SECRET: &str = "secret-de-test-suffisamment-long-pour-hs256-0123456789";

/// Creates a throwaway account. Every test cleans up after itself so the
/// dedicated database can be reused.
async fn make_user(db: &DbPool, role: &str) -> Uuid {
    let suffix = Uuid::new_v4().simple().to_string();
    let id = kubuno_db::new_id();
    db.execute(
        "INSERT INTO core.users (id, email, username, password_hash, role)
         VALUES ($1, $2, $3, $4, $5)",
        params![
            id,
            format!("t-{suffix}@test.invalid"),
            format!("t-{suffix}"),
            "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaasfvMkQ96Cjbu2I0",
            role
        ],
    )
    .await
    .expect("création du compte de test");
    id
}

async fn drop_user(db: &DbPool, id: Uuid) {
    let _ = db
        .execute("DELETE FROM core.users WHERE id = $1", params![id])
        .await;
}

async fn load_user(db: &DbPool, id: Uuid) -> User {
    db.fetch_one_as::<User>("SELECT * FROM core.users WHERE id = $1", params![id])
        .await
        .expect("relecture du compte")
}

async fn set_setting(db: &DbPool, key: &str, value: serde_json::Value) {
    db.execute(
        "INSERT INTO core.settings (key, value, category) VALUES ($1, $2, 'security')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        params![key, value],
    )
    .await
    .expect("écriture du réglage");
}

#[tokio::test]
async fn a_backup_code_works_once_and_never_again() {
    let Some(db) = common::test_pool().await else { return };
    let user = make_user(&db, "user").await;

    let codes = backup_codes::replace_all(&db, user).await.expect("génération");
    assert_eq!(codes.len(), backup_codes::BATCH_SIZE);

    let first = codes[0].clone();

    // First use consumes it and reports what is left.
    let remaining = backup_codes::consume(&db, user, &first, None)
        .await
        .expect("consommation");
    assert_eq!(remaining, Some(backup_codes::BATCH_SIZE as i64 - 1));

    // Replay: same code, same account - refused.
    let replay = backup_codes::consume(&db, user, &first, None)
        .await
        .expect("rejeu");
    assert_eq!(replay, None, "un code de secours ne doit servir qu'une fois");

    // The formatting the user sees is not what the account is keyed on.
    let second_lowercase = codes[1].to_lowercase().replace('-', " ");
    assert!(
        backup_codes::consume(&db, user, &second_lowercase, None)
            .await
            .expect("consommation tolérante")
            .is_some(),
        "la saisie en minuscules sans tiret doit être acceptée"
    );

    drop_user(&db, user).await;
}

#[tokio::test]
async fn regenerating_invalidates_every_previous_code() {
    let Some(db) = common::test_pool().await else { return };
    let user = make_user(&db, "user").await;

    let old = backup_codes::replace_all(&db, user).await.expect("premier lot");
    let new = backup_codes::replace_all(&db, user).await.expect("second lot");

    for code in &old {
        assert_eq!(
            backup_codes::consume(&db, user, code, None).await.expect("ancien code"),
            None,
            "un code du lot précédent doit être refusé après régénération"
        );
    }

    // …and the fresh sheet works.
    assert!(backup_codes::consume(&db, user, &new[0], None)
        .await
        .expect("nouveau code")
        .is_some());

    let status = backup_codes::status(&db, user).await.expect("compteurs");
    assert_eq!(status.total, backup_codes::BATCH_SIZE as i64);
    assert_eq!(status.remaining, backup_codes::BATCH_SIZE as i64 - 1);

    drop_user(&db, user).await;
}

#[tokio::test]
async fn the_low_warning_trips_under_the_threshold() {
    let Some(db) = common::test_pool().await else { return };
    let user = make_user(&db, "user").await;

    let codes = backup_codes::replace_all(&db, user).await.expect("lot");
    assert!(!backup_codes::status(&db, user).await.expect("compteurs").low);

    // Burn down to the threshold.
    let threshold = backup_codes::status(&db, user).await.expect("compteurs").low_threshold;
    let to_burn = backup_codes::BATCH_SIZE as i64 - threshold;
    for code in codes.iter().take(to_burn as usize) {
        backup_codes::consume(&db, user, code, None).await.expect("consommation");
    }

    let status = backup_codes::status(&db, user).await.expect("compteurs");
    assert_eq!(status.remaining, threshold);
    assert!(status.low, "l'avertissement doit se déclencher au seuil");

    drop_user(&db, user).await;
}

#[tokio::test]
async fn a_reauth_grant_expires_and_can_be_revoked() {
    let Some(db) = common::test_pool().await else { return };
    let user = make_user(&db, "admin").await;

    let policy = store::ReauthPolicy { token_ttl_s: 300, grace_s: 900 };
    let jti = store::grant(&db, user, claims::ReauthMethod::Totp, None, policy)
        .await
        .expect("octroi");

    assert!(store::is_live(&db, jti, user).await.expect("vivant"));
    assert!(store::grace_until(&db, user).await.expect("grâce").is_some());

    // A grant belongs to ONE account: presenting it for another must not pass.
    let other = make_user(&db, "admin").await;
    assert!(!store::is_live(&db, jti, other).await.expect("autre compte"));
    drop_user(&db, other).await;

    // Expiry is a database fact, not a claim the client makes.
    db.execute(
        "UPDATE core.reauth_grants SET expires_at = $1 WHERE jti = $2",
        params![Utc::now() - ChronoDuration::seconds(1), jti],
    )
    .await
    .expect("péremption forcée");
    assert!(
        !store::is_live(&db, jti, user).await.expect("périmé"),
        "un droit périmé ne doit plus être honoré"
    );

    // The grace window outlives the token - that is its point - until revoked.
    assert!(store::grace_until(&db, user).await.expect("grâce").is_some());
    store::revoke_all(&db, user).await;
    assert!(store::grace_until(&db, user).await.expect("après révocation").is_none());

    drop_user(&db, user).await;
}

#[tokio::test]
async fn a_reauth_token_is_bound_to_its_grant() {
    let Some(db) = common::test_pool().await else { return };
    let user = make_user(&db, "admin").await;

    let policy = store::policy(&db).await;
    let jti = store::grant(&db, user, claims::ReauthMethod::Password, None, policy)
        .await
        .expect("octroi");
    let token = claims::issue(SECRET, user, jti, claims::ReauthMethod::Password, policy.token_ttl_s)
        .expect("émission");

    let parsed = claims::validate(SECRET, &token).expect("validation");
    assert_eq!(parsed.jti, jti);
    assert_eq!(parsed.sub, user);
    assert!(store::is_live(&db, parsed.jti, user).await.expect("vivant"));

    // Revoking the row makes a signature-valid token worthless: this is exactly
    // what a stateless proof could not offer.
    store::revoke_all(&db, user).await;
    assert!(claims::validate(SECRET, &token).is_ok(), "la signature reste valide");
    assert!(
        !store::is_live(&db, parsed.jti, user).await.expect("révoqué"),
        "le droit révoqué ne doit plus être honoré"
    );

    drop_user(&db, user).await;
}

#[tokio::test]
async fn the_admin_requirement_arms_a_grace_window_then_refuses() {
    let Some(db) = common::test_pool().await else { return };

    // Snapshot the instance settings and restore them at the end: this database
    // is dedicated, but a leftover "2FA obligatoire" would poison later runs.
    let previous: Option<serde_json::Value> = db
        .fetch_optional_scalar::<Option<serde_json::Value>>(
            "SELECT value FROM core.settings WHERE key = 'security.admin_2fa_required'",
            params![],
        )
        .await
        .expect("lecture du réglage")
        .flatten();

    let user = make_user(&db, "admin").await;

    // Requirement off: nothing is armed, nothing is refused.
    set_setting(&db, "security.admin_2fa_required", serde_json::json!(false)).await;
    admin_2fa::enforce(&db, &load_user(&db, user).await)
        .await
        .expect("exigence désactivée : aucun refus");
    assert!(load_user(&db, user).await.admin_2fa_grace_until.is_none());

    // Requirement on: the first look arms the deadline and lets the account
    // through, so an administrator is never refused without warning.
    set_setting(&db, "security.admin_2fa_required", serde_json::json!(true)).await;
    set_setting(&db, "security.admin_2fa_grace_days", serde_json::json!(7)).await;
    admin_2fa::enforce(&db, &load_user(&db, user).await)
        .await
        .expect("dans le délai de grâce");
    let armed = load_user(&db, user).await.admin_2fa_grace_until;
    assert!(armed.is_some(), "le délai de grâce doit être armé");

    // A second look must not push the deadline back.
    admin_2fa::enforce(&db, &load_user(&db, user).await).await.expect("toujours dans le délai");
    assert_eq!(load_user(&db, user).await.admin_2fa_grace_until, armed);

    // Deadline reached: refusal, with the distinguishable error.
    db.execute(
        "UPDATE core.users SET admin_2fa_grace_until = $1 WHERE id = $2",
        params![Utc::now() - ChronoDuration::minutes(1), user],
    )
    .await
    .expect("échéance forcée");
    let err = admin_2fa::enforce(&db, &load_user(&db, user).await).await;
    assert!(
        matches!(err, Err(kubuno_core::errors::AppError::TwoFactorRequired)),
        "le délai écoulé doit refuser l'administration"
    );

    // Turning the requirement OFF disarms the deadline it armed, so switching it
    // on again later hands out a fresh window instead of an immediate refusal.
    set_setting(&db, "security.admin_2fa_required", serde_json::json!(false)).await;
    admin_2fa::enforce(&db, &load_user(&db, user).await)
        .await
        .expect("exigence retirée : aucun refus");
    assert!(
        load_user(&db, user).await.admin_2fa_grace_until.is_none(),
        "désactiver l'exigence doit désarmer l'échéance"
    );
    set_setting(&db, "security.admin_2fa_required", serde_json::json!(true)).await;
    admin_2fa::enforce(&db, &load_user(&db, user).await)
        .await
        .expect("nouveau délai de grâce");
    assert!(load_user(&db, user).await.admin_2fa_grace_until.is_some());

    // Enrolling clears the deadline and reopens the console.
    db.execute(
        "UPDATE core.users SET totp_enabled = TRUE WHERE id = $1",
        params![user],
    )
    .await
    .expect("activation du second facteur");
    admin_2fa::clear_deadline(&db, user).await;
    admin_2fa::enforce(&db, &load_user(&db, user).await)
        .await
        .expect("second facteur configuré : accès rendu");

    drop_user(&db, user).await;
    set_setting(
        &db,
        "security.admin_2fa_required",
        previous.unwrap_or(serde_json::json!(false)),
    )
    .await;
}

#[tokio::test]
async fn disabling_the_second_factor_drops_the_codes() {
    let Some(db) = common::test_pool().await else { return };
    let user = make_user(&db, "user").await;

    backup_codes::replace_all(&db, user).await.expect("lot");
    assert_eq!(
        backup_codes::status(&db, user).await.expect("compteurs").remaining,
        backup_codes::BATCH_SIZE as i64
    );

    let dropped = backup_codes::clear(&db, user).await.expect("purge");
    assert_eq!(dropped, backup_codes::BATCH_SIZE as u64);

    let status = backup_codes::status(&db, user).await.expect("compteurs");
    assert_eq!(status.remaining, 0);
    assert!(!status.low, "sans lot du tout il n'y a rien à avertir");

    drop_user(&db, user).await;
}
