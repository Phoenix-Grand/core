//! Device inventory: correlation, the tri-state rule, and revocation.
//!
//! Needs a throwaway database - see `tests/common/mod.rs`. Without
//! `KUBUNO_TEST_DATABASE_URL` every test prints a notice and passes, so a CI
//! without PostgreSQL does not turn red on a missing fixture.

mod common;

use kubuno_core::devices::{
    correlate::{self, fingerprint_key},
    model::{AuthStrength, Tri},
    store, user_agent,
};
use kubuno_db::{params, DbPool};
use uuid::Uuid;

const CHROME: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const IPHONE: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

/// Creates a throwaway account. Prefixed so the cleanup below cannot touch a
/// real one even if the test database were pointed at something it should not be.
async fn seed_user(db: &DbPool) -> Uuid {
    let tag = Uuid::new_v4().simple().to_string();
    let id = kubuno_db::new_id();
    db.execute(
        "INSERT INTO core.users (id, email, username, password_hash, display_name)
         VALUES ($1, $2, $3, 'x', 'Inventaire test')",
        params![
            id,
            format!("devtest-{tag}@example.invalid"),
            format!("devtest-{tag}")
        ],
    )
    .await
    .expect("création du compte de test");
    id
}

async fn cleanup(db: &DbPool, user_id: Uuid) {
    // `core.devices` and `core.refresh_tokens` cascade from the account.
    let _ = db
        .execute("DELETE FROM core.users WHERE id = $1", params![user_id])
        .await;
}

async fn open_session(db: &DbPool, user_id: Uuid, device_id: Uuid, strength: AuthStrength) -> Uuid {
    let id = kubuno_db::new_id();
    db.execute(
        "INSERT INTO core.refresh_tokens
             (id, user_id, token_hash, expires_at, client_type)
         VALUES ($1, $2, $3, NOW() + INTERVAL '30 days', 'web')",
        params![id, user_id, Uuid::new_v4().simple().to_string()],
    )
    .await
    .expect("création de la session de test");

    correlate::attach_session(db, id, device_id, Some("FR"), strength)
        .await
        .expect("rattachement de la session");
    id
}

/// The same browser signing in twice must be ONE device, not two.
#[tokio::test]
async fn correlation_is_idempotent_and_separates_machines() {
    let Some(db) = common::test_pool().await else { return };
    let user = seed_user(&db).await;

    let laptop_ua = user_agent::normalise(CHROME);
    let phone_ua = user_agent::normalise(IPHONE);
    let laptop = fingerprint_key(user, "web", &laptop_ua);
    let phone = fingerprint_key(user, "web", &phone_ua);

    let first = correlate::upsert(&db, user, &laptop, &laptop_ua, CHROME, "web", None, None)
        .await
        .expect("premier contact");
    assert!(first.created, "le premier contact crée la fiche");

    let second = correlate::upsert(&db, user, &laptop, &laptop_ua, CHROME, "web", None, None)
        .await
        .expect("second contact");
    assert!(!second.created, "le second contact ne doit pas créer de fiche");
    assert_eq!(first.device_id, second.device_id, "même appareil, même fiche");

    let other = correlate::upsert(&db, user, &phone, &phone_ua, IPHONE, "web", None, None)
        .await
        .expect("autre appareil");
    assert_ne!(first.device_id, other.device_id, "deux machines, deux fiches");

    let devices = store::for_user(&db, user).await.expect("lecture des appareils");
    assert_eq!(devices.len(), 2);

    // The platform is deduced, not taken from anything the client asserted.
    let platforms: Vec<Option<String>> = devices.iter().map(|d| d.platform.clone()).collect();
    assert!(platforms.contains(&Some("Windows".into())));
    assert!(platforms.contains(&Some("iOS".into())));

    cleanup(&db, user).await;
}

/// The correlation identifier is a secret: it must not be reachable through any
/// of the shapes the API serialises.
#[tokio::test]
async fn the_correlation_identifier_never_reaches_the_json() {
    let Some(db) = common::test_pool().await else { return };
    let user = seed_user(&db).await;

    let ua = user_agent::normalise(CHROME);
    let key = fingerprint_key(user, "web", &ua);
    let hash = key.hash();
    let touched = correlate::upsert(&db, user, &key, &ua, CHROME, "web", None, None)
        .await
        .expect("upsert");

    let devices = store::for_user(&db, user).await.expect("lecture");
    let json = serde_json::to_string(
        &devices.iter().map(|d| d.to_json()).collect::<Vec<_>>(),
    )
    .expect("sérialisation");

    assert!(!json.contains(&hash), "le hachage de corrélation ne doit jamais être sérialisé");
    assert!(!json.contains("correlation_hash"), "le champ lui-même ne doit pas exister");
    // The PUBLIC identifier is what the API speaks in, and it is present.
    assert!(json.contains(&touched.device_id.to_string()));

    cleanup(&db, user).await;
}

/// Unknown is not false. A device that never declared anything must not satisfy
/// a question asking for encryption, and must not be stored as a negative.
#[tokio::test]
async fn unknown_is_stored_as_unknown_and_never_satisfies_encrypted() {
    let Some(db) = common::test_pool().await else { return };
    let user = seed_user(&db).await;

    let ua = user_agent::normalise(CHROME);
    let key = fingerprint_key(user, "web", &ua);
    correlate::upsert(&db, user, &key, &ua, CHROME, "web", None, None)
        .await
        .expect("upsert");

    let device = store::for_user(&db, user)
        .await
        .expect("lecture")
        .pop()
        .expect("une fiche");

    assert_eq!(device.disk_encrypted(), Tri::Unknown);
    assert_eq!(device.screen_lock(), Tri::Unknown);
    assert!(!device.disk_encrypted().is_encrypted(), "« inconnu » ne satisfait pas « chiffré »");
    assert_eq!(device.signal_level, "observed");

    // On the wire it is the WORD "unknown", not a JSON null a client could read
    // with `?? false`.
    let json = device.to_json();
    assert_eq!(json["disk_encrypted"], serde_json::json!("unknown"));
    assert_eq!(json["screen_lock"], serde_json::json!("unknown"));
    assert!(json["disk_encrypted"] != serde_json::Value::Null);

    // An explicit negative declaration is a different statement, and it is the
    // only one that may read as "no".
    db.execute(
        "UPDATE core.devices SET disk_encrypted = FALSE, signal_level = 'declared' WHERE id = $1",
        params![device.id],
    )
    .await
    .expect("déclaration négative");
    let redeclared = store::get_owned(&db, device.id, user).await.expect("relecture");
    assert_eq!(redeclared.disk_encrypted(), Tri::No);
    assert!(!redeclared.disk_encrypted().is_encrypted());

    cleanup(&db, user).await;
}

/// Blocking closes the live sessions; forgetting does not.
#[tokio::test]
async fn revocation_closes_sessions_and_forgetting_does_not() {
    let Some(db) = common::test_pool().await else { return };
    let user = seed_user(&db).await;

    let ua = user_agent::normalise(CHROME);
    let key = fingerprint_key(user, "web", &ua);
    let touched = correlate::upsert(&db, user, &key, &ua, CHROME, "web", None, None)
        .await
        .expect("upsert");

    open_session(&db, user, touched.device_id, AuthStrength::Password).await;
    open_session(&db, user, touched.device_id, AuthStrength::PasswordTotp).await;

    let sessions = store::sessions_of(&db, touched.device_id).await.expect("sessions");
    assert_eq!(sessions.len(), 2);
    // The strength travels with the session: "which of these passed 2FA" has an
    // answer.
    assert!(sessions.iter().any(|s| s.auth_strength.as_deref() == Some("password_totp")));
    assert!(sessions.iter().any(|s| s.auth_strength.as_deref() == Some("password")));

    let revoked = {
        let mut tx = db.begin().await.expect("transaction");
        let n = store::revoke_sessions(&mut tx, touched.device_id, "device_blocked")
            .await
            .expect("révocation");
        tx.commit().await.expect("commit");
        n
    };
    assert_eq!(revoked, 2);
    assert!(store::sessions_of(&db, touched.device_id).await.expect("relecture").is_empty());

    // A second run revokes nothing: revocation is idempotent.
    let again = {
        let mut tx = db.begin().await.expect("transaction");
        let n = store::revoke_sessions(&mut tx, touched.device_id, "device_blocked")
            .await
            .expect("seconde révocation");
        tx.commit().await.expect("commit");
        n
    };
    assert_eq!(again, 0);

    // Forgetting removes the inventory row and NOTHING else: the sessions -
    // even revoked ones - survive, because forgetting is not a sign-out and
    // certainly not an erasure on the machine.
    let before: i64 = db
        .fetch_scalar::<i64>(
            "SELECT COUNT(*)::bigint FROM core.refresh_tokens WHERE user_id = $1",
            params![user],
        )
        .await
        .expect("comptage");
    {
        let mut tx = db.begin().await.expect("transaction");
        store::forget(&mut tx, touched.device_id).await.expect("oubli");
        tx.commit().await.expect("commit");
    }

    let after: i64 = db
        .fetch_scalar::<i64>(
            "SELECT COUNT(*)::bigint FROM core.refresh_tokens WHERE user_id = $1",
            params![user],
        )
        .await
        .expect("comptage");
    assert_eq!(before, after, "oublier une fiche ne supprime aucune session");

    // Detached, not destroyed: `ON DELETE SET NULL` on `device_id`.
    //
    // The assertion is written against the FORGOTTEN id rather than "device_id
    // IS NULL", because the tests share one database and a concurrent
    // `backfill` - which is instance-wide by design - may legitimately have
    // re-attached a detached session to a fresh fingerprint row in the
    // meantime. What must never happen is a session still pointing at a device
    // that no longer exists.
    let still_pointing: i64 = db
        .fetch_scalar::<i64>(
            "SELECT COUNT(*)::bigint FROM core.refresh_tokens WHERE user_id = $1 AND device_id = $2",
            params![user, touched.device_id],
        )
        .await
        .expect("comptage");
    assert_eq!(still_pointing, 0, "aucune session ne pointe vers la fiche oubliée");

    let gone = store::get_owned(&db, touched.device_id, user).await;
    assert!(gone.is_err(), "la fiche oubliée n'est plus lisible");

    cleanup(&db, user).await;
}

/// Sessions that predate the inventory are attached to a device by fingerprint,
/// using the very same normaliser as the live path.
#[tokio::test]
async fn the_backfill_attaches_pre_existing_sessions() {
    let Some(db) = common::test_pool().await else { return };
    let user = seed_user(&db).await;

    // Two sessions of the same browser, as they were written before this table
    // existed: a user agent, no device.
    for _ in 0..2 {
        db.execute(
            "INSERT INTO core.refresh_tokens (id, user_id, token_hash, user_agent, expires_at, client_type)
             VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 days', 'web')",
            params![
                kubuno_db::new_id(),
                user,
                Uuid::new_v4().simple().to_string(),
                CHROME
            ],
        )
        .await
        .expect("session héritée");
    }

    correlate::backfill(&db).await.expect("rattachement");

    let devices = store::for_user(&db, user).await.expect("lecture");
    assert_eq!(devices.len(), 1, "un seul navigateur, une seule fiche");
    assert_eq!(devices[0].platform.as_deref(), Some("Windows"));
    assert_eq!(devices[0].correlation_kind, "fingerprint");
    assert_eq!(devices[0].active_sessions, 2);

    // Idempotent: a second pass finds nothing left to attach for this account.
    let attached = correlate::backfill(&db).await.expect("second passage");
    let _ = attached; // other accounts of the test database may still have rows
    assert_eq!(
        store::for_user(&db, user).await.expect("relecture").len(),
        1,
        "le second passage ne doit pas dupliquer la fiche"
    );

    cleanup(&db, user).await;
}
