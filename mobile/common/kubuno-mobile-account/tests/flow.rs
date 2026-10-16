//! The account layer against a mock Kubuno core that reproduces the real native auth contract (see `mock/mod.rs`):
//! sign-in, second factor, session restore, refresh rotation (single-flight), a 401 retried after a refresh, reuse
//! detection, a transient failure that does not end the session, sign-out and the server probe.

mod mock;

use std::sync::Arc;

use kubuno_mobile_account::{
    accounts, login, normalize_server, probe_server, verify_totp, AccountError, AuthError, LoginOptions,
    LoginOutcome, MemorySecretStore, Session, TokenSource,
};

fn opts(server: &str, login: &str, password: &str) -> LoginOptions {
    LoginOptions {
        server: server.to_string(),
        device_key: "device-1".into(),
        device_name: "Test phone".into(),
        login: login.into(),
        password: password.into(),
    }
}

async fn sign_in(server: &str) -> (Session, Arc<MemorySecretStore>) {
    let LoginOutcome::Tokens(tokens) = login(opts(server, "zoe@kubuno.test", mock::PASSWORD)).await.expect("login")
    else {
        panic!("no second factor expected")
    };
    let store = Arc::new(MemorySecretStore::new());
    (Session::adopt(store.clone(), server, "device-1", tokens).expect("adopt"), store)
}

#[tokio::test(flavor = "multi_thread")]
async fn sign_in_call_the_server_restore_and_sign_out() {
    let (addr, _mock) = mock::serve("127.0.0.1:0", 900, 900).await;
    let server = format!("http://{addr}");
    assert_eq!(probe_server(&server, "device-1").await.expect("probe"), "mock");

    let (session, store) = sign_in(&server).await;
    assert_eq!(session.account.label, "Zoé Test");
    assert_eq!(session.me().await.expect("me").display_name.as_deref(), Some("Zoé Test"));
    assert_eq!(accounts(store.as_ref()).unwrap().len(), 1);

    // A later launch reopens the session from the secret store alone.
    let restored = Session::restore_last(store.clone()).unwrap().expect("restored");
    assert_eq!(restored.account, session.account);
    assert_eq!(restored.me().await.expect("me after restore").id, "u-zoe");

    restored.sign_out(store.clone()).await.expect("sign out");
    assert!(Session::restore_last(store.clone()).unwrap().is_none());
    assert!(accounts(store.as_ref()).unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn wrong_password_and_second_factor() {
    let (addr, _mock) = mock::serve("127.0.0.1:0", 900, 900).await;
    let server = format!("http://{addr}");
    let err = login(opts(&server, "zoe@kubuno.test", "nope")).await.expect_err("rejected");
    assert!(matches!(&err, AccountError::Api(e) if e.status() == Some(401)), "{err:?}");

    let LoginOutcome::TotpRequired(pending) = login(opts(&server, "totp@kubuno.test", mock::PASSWORD)).await.unwrap()
    else {
        panic!("a second factor is expected")
    };
    assert!(verify_totp(&pending, "000000").await.is_err());
    let tokens = verify_totp(&pending, mock::TOTP_CODE).await.expect("code accepted");
    assert_eq!(tokens.user.id, "u-totp");
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_requests_refresh_once_and_the_rotated_token_is_stored() {
    // The sign-in access token is about to expire (30 s, inside the refresh skew); refreshed ones live 15 min.
    let (addr, mock) = mock::serve("127.0.0.1:0", 30, 900).await;
    let server = format!("http://{addr}");
    let (session, store) = sign_in(&server).await;

    let calls: Vec<_> = (0..5).map(|_| tokio::spawn({ let s = session.clone(); async move { s.me().await } })).collect();
    for c in calls {
        c.await.expect("join").expect("me");
    }
    assert_eq!(mock.lock().unwrap().refresh_calls, 1, "single-flight: one refresh for five concurrent requests");
    let stored = kubuno_mobile_account::SecretStore::load(
        store.as_ref(),
        &kubuno_mobile_account::refresh_key(&server, "u-zoe"),
    )
    .unwrap();
    assert_eq!(stored.as_deref(), Some("r-zoe@kubuno.test-2"), "the rotated refresh token replaced the first one");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rejected_access_token_is_refreshed_and_the_request_retried() {
    let (addr, mock) = mock::serve("127.0.0.1:0", 900, 900).await;
    let server = format!("http://{addr}");
    let (session, _store) = sign_in(&server).await;
    reqwest_post(&format!("{server}/test/expire-access")).await;
    assert_eq!(session.me().await.expect("me after 401").id, "u-zoe");
    assert_eq!(mock.lock().unwrap().refresh_calls, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_replayed_refresh_token_is_an_expired_session() {
    let (addr, _mock) = mock::serve("127.0.0.1:0", 30, 900).await;
    let server = format!("http://{addr}");
    let (session, store) = sign_in(&server).await;
    // A stale copy of the store (the first refresh token), taken before the session refreshes.
    let stale = Arc::new(MemorySecretStore::new());
    let key = kubuno_mobile_account::refresh_key(&server, "u-zoe");
    let first = kubuno_mobile_account::SecretStore::load(store.as_ref(), &key).unwrap().unwrap();
    kubuno_mobile_account::SecretStore::store(stale.as_ref(), &key, &first).unwrap();
    kubuno_mobile_account::remember(stale.as_ref(), &session.account).unwrap();

    session.me().await.expect("refreshes, spending the first token");
    let replay = Session::restore_last(stale).unwrap().expect("stale session");
    assert_eq!(replay.owner.access_token().await, Err(AuthError::SessionExpired));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_transient_failure_keeps_the_session_and_cools_down() {
    // Nothing listens on port 1: the refresh fails at the network level.
    let store = Arc::new(MemorySecretStore::new());
    let account = kubuno_mobile_account::Account {
        server: "http://127.0.0.1:1".into(),
        user_id: "u-zoe".into(),
        label: "Zoé".into(),
        device_key: "device-1".into(),
    };
    kubuno_mobile_account::SecretStore::store(store.as_ref(), &kubuno_mobile_account::refresh_key(&account.server, "u-zoe"), "r-x")
        .unwrap();
    let owner = kubuno_mobile_account::TokenOwner::restore(&account, store.clone()).unwrap().unwrap();
    assert!(matches!(owner.access_token().await, Err(AuthError::Transient(_))));
    match owner.access_token().await {
        Err(AuthError::Transient(m)) => assert!(m.contains("cooling down"), "{m}"),
        other => panic!("expected a cooldown, got {other:?}"),
    }
    assert!(kubuno_mobile_account::SecretStore::load(store.as_ref(), &kubuno_mobile_account::refresh_key(&account.server, "u-zoe"))
        .unwrap()
        .is_some(), "a transient failure never drops the refresh token");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_server_that_is_not_kubuno_is_refused() {
    // An HTTP server with no /health: something answers, but not a Kubuno core.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, axum::Router::new()).await;
    });
    let err = probe_server(&format!("http://{addr}"), "d").await.expect_err("not kubuno");
    assert!(matches!(err, AccountError::NotKubuno), "{err:?}");
    assert!(matches!(normalize_server("  "), Err(AccountError::InvalidServer)));
}

async fn reqwest_post(url: &str) {
    let api = kubuno_mobile_account::unauth_client(url.rsplit_once("/test").map(|(b, _)| b).unwrap(), "d").unwrap();
    api.send(kubuno_mobile_account::ApiRequest::post("/test/expire-access").unauthenticated()).await.expect("hook");
}
