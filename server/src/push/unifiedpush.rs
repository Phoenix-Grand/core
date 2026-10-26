//! UnifiedPush provider: POST the JSON payload to the distributor endpoint.
//!
//! The `device_token` is the endpoint URL the client obtained from its
//! distributor (ntfy, NextPush…). We only POST; the response body is not read
//! and not trusted. To limit SSRF, only `https://` endpoints are accepted.

use crate::push::{PushNotification, PushProvider};

pub struct UnifiedPush;

#[async_trait::async_trait]
impl PushProvider for UnifiedPush {
    async fn send(
        &self,
        client: &reqwest::Client,
        endpoint: &str,
        notif: &PushNotification,
    ) -> anyhow::Result<bool> {
        // SSRF guard: refuse non-HTTPS endpoints (no internal http://169.254… etc.).
        if !endpoint.starts_with("https://") {
            anyhow::bail!("Non-HTTPS UnifiedPush endpoint rejected");
        }

        let resp = client
            .post(endpoint)
            .json(notif)
            .send()
            .await?;

        let status = resp.status();
        // 404/410 → the subscription is gone; signal pruning.
        if status.as_u16() == 404 || status.as_u16() == 410 {
            return Ok(false);
        }
        if !status.is_success() {
            anyhow::bail!("UnifiedPush returned {status}");
        }
        Ok(true)
    }
}
