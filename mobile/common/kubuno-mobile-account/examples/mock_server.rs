//! A mock Kubuno core for checking the mobile sign-in on a device or emulator without a real server:
//! `cargo run -p kubuno-mobile-account --example mock_server -- 127.0.0.1:8787` (the Android emulator reaches its host
//! as `http://10.0.2.2:8787`). Accounts: `zoe@kubuno.test` / `secret`, `totp@kubuno.test` / `secret` (code `123456`).
//! The same mock the integration tests use; it reproduces the real native auth contract.

#[path = "../tests/mock/mod.rs"]
mod mock;

#[tokio::main]
async fn main() {
    let addr = std::env::args().nth(1).unwrap_or_else(|| "127.0.0.1:8787".to_string());
    let (bound, mock) = mock::serve(&addr, 900, 900).await;
    println!("mock Kubuno core on http://{bound} - zoe@kubuno.test / secret, totp@kubuno.test / secret (code 123456)");
    let mut last = (0, 0);
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        let now = {
            let m = mock.lock().expect("mock");
            (m.logins, m.refresh_calls)
        };
        if now != last {
            println!("logins={} refreshes={}", now.0, now.1);
            last = now;
        }
    }
}
