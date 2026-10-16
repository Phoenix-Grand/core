//! Vérifie la terminaison TLS native (HTTPS) - exerce exactement les APIs
//! utilisées par main.rs : provider ring + RustlsConfig::from_pem_file +
//! axum_server::bind_rustls, avec un vrai handshake TLS côté client (reqwest).

use std::net::SocketAddr;
use std::time::Duration;

use axum::{routing::get, Router};
use axum_server::tls_rustls::RustlsConfig;

fn ensure_cert() -> Option<(String, String)> {
    let dir = "/tmp/kbtls";
    let cert = format!("{dir}/cert.pem");
    let key = format!("{dir}/key.pem");
    if std::path::Path::new(&cert).is_file() && std::path::Path::new(&key).is_file() {
        return Some((cert, key));
    }
    // Génère un cert auto-signé (tests = pas de seccomp).
    let _ = std::fs::create_dir_all(dir);
    let ok = std::process::Command::new("openssl")
        .args([
            "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", &key, "-out", &cert, "-days", "1",
            "-subj", "/CN=localhost",
        ])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok { Some((cert, key)) } else { None }
}

#[tokio::test]
async fn https_native_serves_over_tls() {
    let Some((cert, key)) = ensure_cert() else {
        eprintln!("openssl indisponible - test TLS ignoré");
        return;
    };

    // Provider crypto explicite (comme main.rs).
    let _ = rustls::crypto::ring::default_provider().install_default();

    let config = RustlsConfig::from_pem_file(&cert, &key)
        .await
        .expect("RustlsConfig::from_pem_file doit charger le cert/clé");

    // Port libre (bind→drop→réutilise).
    let addr: SocketAddr = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap()
    };

    let app = Router::new().route("/health", get(|| async { "OK-TLS" }));
    let handle = tokio::spawn(async move {
        axum_server::bind_rustls(addr, config)
            .serve(app.into_make_service())
            .await
            .unwrap();
    });

    tokio::time::sleep(Duration::from_millis(400)).await;

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true) // cert auto-signé
        .build()
        .unwrap();
    let resp = client
        .get(format!("https://{addr}/health"))
        .send()
        .await
        .expect("la requête HTTPS doit aboutir (handshake TLS)");
    assert_eq!(resp.status(), 200, "statut HTTPS");
    assert_eq!(resp.text().await.unwrap(), "OK-TLS", "corps servi en HTTPS");

    handle.abort();
}
