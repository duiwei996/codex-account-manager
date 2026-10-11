//! Plain JSON account transfer, compatible with Codex and CLIProxyAPI.
use crate::auth::{load_accounts, update_accounts};
use crate::types::{
    parse_chatgpt_id_token_claims, AuthData, AuthDotJson, ImportAccountsSummary, StoredAccount,
};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use std::path::Path;

const MAX_JSON_BYTES: usize = 8 * 1024 * 1024;

#[derive(serde::Serialize)]
pub struct ExportDocument {
    account_id: String,
    name: String,
    content: String,
}

fn token_expiry(token: &str) -> Option<String> {
    let payload = URL_SAFE_NO_PAD.decode(token.split('.').nth(1)?).ok()?;
    let claims: Value = serde_json::from_slice(&payload).ok()?;
    chrono::DateTime::from_timestamp(claims.get("exp")?.as_i64()?, 0).map(|time| time.to_rfc3339())
}

fn export_value(account: &StoredAccount, format: &str) -> Result<Value> {
    match (&account.auth_data, format) {
        (AuthData::ApiKey { key }, "official") => Ok(json!({"OPENAI_API_KEY":key})),
        (
            AuthData::ChatGPT {
                id_token,
                access_token,
                refresh_token,
                account_id,
            },
            "official",
        ) => Ok(json!({
            "OPENAI_API_KEY":null,
            "tokens":{"id_token":id_token,"access_token":access_token,"refresh_token":refresh_token,"account_id":account_id},
            "last_refresh":account.credentials_updated_at
        })),
        (
            AuthData::ChatGPT {
                id_token,
                access_token,
                refresh_token,
                account_id,
            },
            "cpa",
        ) => Ok(json!({
            "type":"codex","id_token":id_token,"access_token":access_token,"refresh_token":refresh_token,
            "account_id":account_id.as_deref().unwrap_or_default(),"email":account.email.as_deref().unwrap_or_default(),
            "last_refresh":account.credentials_updated_at.map(|time|time.to_rfc3339()).unwrap_or_default(),
            "expired":token_expiry(access_token).unwrap_or_default(),"plan_type":account.plan_type
        })),
        (AuthData::ApiKey { .. }, "cpa") => {
            bail!("CPA Codex 格式仅支持登录账号，请使用官方格式导出 API Key 账号")
        }
        _ => bail!("不支持的导出格式"),
    }
}

fn export_documents(format: &str, account_id: Option<&str>) -> Result<Vec<ExportDocument>> {
    let store = load_accounts()?;
    let selected: Vec<_> = store
        .accounts
        .iter()
        .filter(|account| account_id.is_none_or(|id| account.id == id))
        .collect();
    if selected.is_empty() {
        bail!("没有可导出的账号");
    }
    selected
        .into_iter()
        .map(|account| {
            let label: String = account
                .email
                .as_deref()
                .unwrap_or(&account.name)
                .chars()
                .map(|ch| {
                    if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | '@') {
                        ch
                    } else {
                        '_'
                    }
                })
                .take(80)
                .collect();
            let prefix = if format == "cpa" { "codex" } else { "auth" };
            Ok(ExportDocument {
                account_id: account.id.clone(),
                name: format!("{prefix}-{label}-{}.json", account.id),
                content: serde_json::to_string_pretty(&export_value(account, format)?)?,
            })
        })
        .collect()
}

#[tauri::command]
pub async fn export_accounts_json(
    format: String,
    account_id: Option<String>,
) -> Result<Vec<ExportDocument>, String> {
    export_documents(&format, account_id.as_deref()).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn save_accounts_json(
    format: String,
    account_id: Option<String>,
    path: String,
) -> Result<usize, String> {
    let documents =
        export_documents(&format, account_id.as_deref()).map_err(|error| error.to_string())?;
    let destination = Path::new(&path);
    if account_id.is_none() && !destination.is_dir() {
        return Err("请选择导出文件夹".into());
    }
    let targets: Vec<_> = documents
        .iter()
        .map(|document| {
            if account_id.is_some() {
                destination.to_path_buf()
            } else {
                destination.join(&document.name)
            }
        })
        .collect();
    if account_id.is_none() && targets.iter().any(|path| path.exists()) {
        return Err("文件夹中已有同名导出文件，请选择其他文件夹".into());
    }
    for (document, target) in documents.iter().zip(targets) {
        crate::auth::secure_file::atomic_write(&target, document.content.as_bytes())
            .map_err(|error| error.to_string())?;
    }
    Ok(documents.len())
}

pub(crate) fn parse_account(value: Value) -> Result<StoredAccount> {
    let (auth, fallback_email, fallback_plan) = if value.get("type").and_then(Value::as_str)
        == Some("codex")
        && value.get("tokens").is_none()
    {
        let auth = json!({"tokens":{
            "id_token":value.get("id_token").context("CPA 文件缺少 id_token")?,
            "access_token":value.get("access_token").context("CPA 文件缺少 access_token")?,
            "refresh_token":value.get("refresh_token").context("CPA 文件缺少 refresh_token")?,
            "account_id":value.get("account_id")},"last_refresh":value.get("last_refresh").filter(|v|v.as_str().is_some_and(|s|!s.is_empty()))});
        (
            serde_json::from_value::<AuthDotJson>(auth)?,
            value
                .get("email")
                .and_then(Value::as_str)
                .map(str::to_owned),
            value
                .get("plan_type")
                .and_then(Value::as_str)
                .map(str::to_owned),
        )
    } else {
        (serde_json::from_value::<AuthDotJson>(value)?, None, None)
    };
    let last_refresh = auth.last_refresh;
    let mut account = if let Some(key) = auth.openai_api_key.filter(|key| !key.is_empty()) {
        StoredAccount::new_api_key("API Key".into(), key)
    } else if let Some(tokens) = auth.tokens {
        let claims = parse_chatgpt_id_token_claims(&tokens.id_token);
        StoredAccount::new_chatgpt(
            String::new(),
            claims.email.or(fallback_email),
            claims.plan_type.or(fallback_plan),
            claims.subscription_expires_at,
            tokens.id_token,
            tokens.access_token,
            tokens.refresh_token,
            claims.account_id.or(tokens.account_id),
        )
    } else {
        bail!("文件中没有可导入的账号凭据");
    };
    account.credentials_updated_at = last_refresh;
    crate::auth::validation::validate_account(&account)?;
    Ok(account)
}

fn parse_import_payload(payload: &str) -> Result<Vec<StoredAccount>, String> {
    if payload.len() > MAX_JSON_BYTES {
        return Err("导入文件超过 8 MiB 限制".into());
    }
    let value: Value = serde_json::from_str(payload).map_err(|_| "不是有效的 JSON 文件")?;
    let values = match value {
        Value::Array(values) => values,
        value => vec![value],
    };
    if values.is_empty() || values.len() > crate::auth::validation::MAX_ACCOUNTS {
        return Err("一次可导入 1–200 个账号".into());
    }
    values
        .into_iter()
        .map(parse_account)
        .collect::<Result<_>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn import_accounts_json(payload: String) -> Result<ImportAccountsSummary, String> {
    let accounts = parse_import_payload(&payload)?;
    update_accounts(|store| {
        let total = accounts.len();
        let mut imported = 0;
        for account in accounts {
            crate::auth::storage::upsert_account(store, account)?;
            imported += 1;
        }
        crate::auth::validation::validate_store(store)?;
        Ok(ImportAccountsSummary {
            total_in_payload: total,
            imported_count: imported,
            skipped_count: total - imported,
        })
    })
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn import_accounts_json_file(path: String) -> Result<ImportAccountsSummary, String> {
    let bytes = crate::auth::secure_file::read_limited(Path::new(&path), MAX_JSON_BYTES as u64)
        .map_err(|error| error.to_string())?;
    let payload = String::from_utf8(bytes).map_err(|_| "JSON 文件必须使用 UTF-8 编码")?;
    import_accounts_json(payload).await
}

#[tauri::command]
pub async fn import_accounts_json_files(
    paths: Vec<String>,
) -> Result<ImportAccountsSummary, String> {
    if paths.is_empty() || paths.len() > 200 {
        return Err("一次请选择 1–200 个 JSON 文件".into());
    }
    let mut values = Vec::new();
    let mut total_bytes = 0usize;
    for path in paths {
        let bytes = crate::auth::secure_file::read_limited(Path::new(&path), MAX_JSON_BYTES as u64)
            .map_err(|error| error.to_string())?;
        total_bytes += bytes.len();
        if total_bytes > MAX_JSON_BYTES {
            return Err("批量导入总大小超过 8 MiB 限制".into());
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "选中的文件包含无效 JSON")?;
        match value {
            Value::Array(entries) => values.extend(entries),
            value => values.push(value),
        };
    }
    import_accounts_json(serde_json::to_string(&values).map_err(|error| error.to_string())?).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn account() -> StoredAccount {
        StoredAccount::new_chatgpt(
            "test".into(),
            Some("test@example.com".into()),
            Some("team".into()),
            None,
            format!(
                "e30.{}.test",
                URL_SAFE_NO_PAD.encode(br#"{"email":"test@example.com","exp":2000000000,"https://api.openai.com/auth":{"chatgpt_plan_type":"team"}}"#)
            ),
            format!(
                "e30.{}.test",
                URL_SAFE_NO_PAD.encode(br#"{"exp":2000000000}"#)
            ),
            "synthetic-refresh".into(),
            Some("synthetic-account".into()),
        )
    }
    #[test]
    fn official_and_cpa_roundtrip_preserve_tokens_and_refresh_timestamp() {
        let mut account = account();
        account.credentials_updated_at = chrono::DateTime::from_timestamp(1900000000, 0);
        for format in ["official", "cpa"] {
            let value = export_value(&account, format).unwrap();
            let restored = parse_account(value).unwrap();
            assert!(crate::auth::storage::same_account_type(&restored, &account));
            assert_eq!(
                restored.credentials_updated_at,
                account.credentials_updated_at
            );
            assert_eq!(
                serde_json::to_value(restored.auth_data).unwrap(),
                serde_json::to_value(&account.auth_data).unwrap()
            );
        }
        assert_eq!(
            export_value(&account, "cpa").unwrap()["expired"],
            "2033-05-18T03:33:20+00:00"
        );
    }
    #[test]
    fn api_key_uses_official_format_and_invalid_files_are_rejected() {
        let account = StoredAccount::new_api_key("test".into(), "synthetic-api-key".into());
        assert!(parse_account(export_value(&account, "official").unwrap()).is_ok());
        assert!(export_value(&account, "cpa").is_err());
        assert!(parse_account(json!({"type":"codex"})).is_err());
        assert!(parse_account(json!({})).is_err());
    }

    #[test]
    fn batch_accepts_mixed_formats_and_validates_every_entry_before_storage() {
        let account = account();
        let official = export_value(&account, "official").unwrap();
        let cpa = export_value(&account, "cpa").unwrap();
        let mixed = serde_json::to_string(&vec![official.clone(), cpa]).unwrap();
        assert_eq!(parse_import_payload(&mixed).unwrap().len(), 2);
        let invalid = serde_json::to_string(&vec![official, json!({"type":"codex"})]).unwrap();
        assert!(parse_import_payload(&invalid).is_err());
        assert!(parse_import_payload("[]").is_err());
        assert!(parse_import_payload(&"x".repeat(MAX_JSON_BYTES + 1)).is_err());
    }
}
