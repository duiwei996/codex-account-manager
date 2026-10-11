//! Bounded network requests; never include provider response bodies in errors.
use anyhow::{Context, Result};
use futures::StreamExt;
use serde::de::DeserializeOwned;
use std::{sync::LazyLock, time::Duration};
use zeroize::Zeroizing;
static CLIENT: LazyLock<Result<reqwest::Client, reqwest::Error>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
});
pub fn client() -> Result<&'static reqwest::Client> {
    CLIENT
        .as_ref()
        .map_err(|_| anyhow::anyhow!("Could not initialize HTTPS client"))
}
pub async fn body(response: reqwest::Response) -> Result<Zeroizing<Vec<u8>>> {
    const LIMIT: usize = 2 * 1024 * 1024;
    if response.content_length().is_some_and(|n| n > LIMIT as u64) {
        anyhow::bail!("Provider response is too large");
    }
    let mut bytes = Zeroizing::new(Vec::new());
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("Could not read provider response")?;
        if bytes.len().saturating_add(chunk.len()) > LIMIT {
            anyhow::bail!("Provider response is too large");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
pub async fn json<T: DeserializeOwned>(response: reqwest::Response) -> Result<T> {
    serde_json::from_slice(&body(response).await?).context("Invalid provider response format")
}
