//! Account-scoped Codex rate-limit reset credits.

use chrono::{DateTime, Utc};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};
use serde::{Deserialize, Serialize};

use crate::auth::{ensure_chatgpt_tokens_fresh, get_account};
use crate::types::{AuthData, AuthMode, StoredAccount};

const CHATGPT_RESET_CREDITS_URL: &str =
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CODEX_USER_AGENT: &str = "codex-cli/1.0.0";

#[derive(Debug, Clone, Serialize)]
pub struct AccountResetCredits {
    pub available_count: i64,
    pub next_expires_at: Option<String>,
    pub credits: Vec<AccountResetCredit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountResetCredit {
    pub id: String,
    pub reset_type: String,
    pub status: String,
    pub granted_at: Option<String>,
    pub expires_at: Option<String>,
    pub redeem_started_at: Option<String>,
    pub redeemed_at: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ResetCreditsResponse {
    #[serde(default)]
    credits: Vec<ResetCredit>,
    #[serde(default)]
    available_count: i64,
}

#[derive(Debug, Deserialize)]
struct ResetCredit {
    id: String,
    reset_type: String,
    status: String,
    #[serde(default)]
    granted_at: Option<String>,
    #[serde(default)]
    expires_at: Option<String>,
    #[serde(default)]
    redeem_started_at: Option<String>,
    #[serde(default)]
    redeemed_at: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
}

#[tauri::command]
pub async fn get_account_reset_credits(account_id: String) -> Result<AccountResetCredits, String> {
    let account = get_account(&account_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Account not found".to_string())?;
    if let Some(error) = account.unavailable_error() {
        return Err(error.into());
    }
    if account.auth_mode != AuthMode::ChatGPT {
        return Err("Reset credits are available for ChatGPT accounts only".into());
    }
    let account = ensure_chatgpt_tokens_fresh(&account)
        .await
        .map_err(|error| error.to_string())?;
    fetch_reset_credits(&account)
        .await
        .map_err(|error| error.to_string())
}

async fn fetch_reset_credits(account: &StoredAccount) -> anyhow::Result<AccountResetCredits> {
    let (access_token, chatgpt_account_id) = extract_chatgpt_auth(account)?;
    let client = crate::api::http::client()?;
    let response = client
        .get(CHATGPT_RESET_CREDITS_URL)
        .headers(build_reset_credits_headers(
            access_token,
            chatgpt_account_id,
        )?)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        anyhow::bail!("Reset credits request failed: {status}");
    }

    let payload: ResetCreditsResponse = crate::api::http::json(response).await?;
    Ok(map_reset_credits(payload, Utc::now()))
}

fn map_reset_credits(payload: ResetCreditsResponse, now: DateTime<Utc>) -> AccountResetCredits {
    let next_expires_at = payload
        .credits
        .iter()
        .filter(|credit| credit.status == "available")
        .filter_map(|credit| {
            credit
                .expires_at
                .as_ref()
                .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
                .map(|value| value.with_timezone(&Utc))
                .filter(|value| *value > now)
                .map(|value| value.to_rfc3339())
        })
        .min();

    AccountResetCredits {
        available_count: payload.available_count.max(0),
        next_expires_at,
        credits: payload.credits.into_iter().map(map_reset_credit).collect(),
    }
}

fn map_reset_credit(credit: ResetCredit) -> AccountResetCredit {
    AccountResetCredit {
        id: credit.id,
        reset_type: credit.reset_type,
        status: credit.status,
        granted_at: credit.granted_at,
        expires_at: credit.expires_at,
        redeem_started_at: credit.redeem_started_at,
        redeemed_at: credit.redeemed_at,
        title: credit.title,
        description: credit.description,
    }
}

fn build_chatgpt_headers(
    access_token: &str,
    chatgpt_account_id: Option<&str>,
) -> anyhow::Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(CODEX_USER_AGENT));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {access_token}"))?,
    );

    if let Some(account_id) = chatgpt_account_id {
        headers.insert(
            HeaderName::from_static("chatgpt-account-id"),
            HeaderValue::from_str(account_id)?,
        );
    }

    Ok(headers)
}

fn build_reset_credits_headers(
    access_token: &str,
    chatgpt_account_id: Option<&str>,
) -> anyhow::Result<HeaderMap> {
    let mut headers = build_chatgpt_headers(access_token, chatgpt_account_id)?;
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(
        HeaderName::from_static("openai-beta"),
        HeaderValue::from_static("codex-1"),
    );
    headers.insert(
        HeaderName::from_static("originator"),
        HeaderValue::from_static("Codex Desktop"),
    );
    Ok(headers)
}

fn extract_chatgpt_auth(account: &StoredAccount) -> anyhow::Result<(&str, Option<&str>)> {
    match &account.auth_data {
        AuthData::ChatGPT {
            access_token,
            account_id,
            ..
        } => Ok((access_token.as_str(), account_id.as_deref())),
        AuthData::ApiKey { .. } => anyhow::bail!("Account is not using ChatGPT OAuth"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reset_credits_response_maps_available_count_and_next_expiry() {
        let payload: ResetCreditsResponse = serde_json::from_value(serde_json::json!({
            "credits": [
                {
                    "id": "expired-available",
                    "reset_type": "codex_rate_limits",
                    "status": "available",
                    "granted_at": "2026-05-18T00:39:53Z",
                    "expires_at": "2026-06-17T00:39:53Z"
                },
                {
                    "id": "later",
                    "reset_type": "codex_rate_limits",
                    "status": "available",
                    "granted_at": "2026-06-18T00:39:53.731630Z",
                    "expires_at": "2026-07-18T00:39:53.731630Z"
                },
                {
                    "id": "earlier",
                    "reset_type": "codex_rate_limits",
                    "status": "available",
                    "granted_at": "2026-06-12T04:03:43.263391Z",
                    "expires_at": "2026-07-12T04:03:43.263391Z",
                    "title": "One free rate limit reset"
                },
                {
                    "id": "redeemed",
                    "reset_type": "codex_rate_limits",
                    "status": "redeemed",
                    "granted_at": "2026-06-12T04:03:43Z",
                    "expires_at": "2026-07-10T04:03:43Z"
                }
            ],
            "available_count": 2
        }))
        .unwrap();

        let now = DateTime::parse_from_rfc3339("2026-06-26T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let stats = map_reset_credits(payload, now);

        assert_eq!(stats.available_count, 2);
        assert_eq!(stats.credits.len(), 4);
        assert_eq!(
            stats.next_expires_at.as_deref(),
            Some("2026-07-12T04:03:43.263391+00:00")
        );
        assert_eq!(
            stats.credits[2].title.as_deref(),
            Some("One free rate limit reset")
        );
    }
}
