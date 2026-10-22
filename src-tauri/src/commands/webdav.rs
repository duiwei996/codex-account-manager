//! Small, portable WebDAV snapshots. Cloud data is compressed, deliberately not encrypted.
use super::webdav_cache::{self as quota_cache, AccountCache, MetadataCache};
use crate::{
    auth,
    types::{AccountsStore, AppSettings, AuthData, StoredAccount},
};
use anyhow::{bail, Context, Result};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use reqwest::{Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Write},
    path::PathBuf,
    time::Duration,
};
use tauri::Emitter;

const LIMIT: usize = 8 * 1024 * 1024;
const FILE: &str = "accounts.sync.gz";
static SYNC_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
type Fields = BTreeMap<String, Value>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DavConfig {
    pub server: String,
    pub username: String,
    pub directory: String,
    pub sync_accounts: bool,
    pub sync_settings: bool,
    pub auto_sync: bool,
}
impl Default for DavConfig {
    fn default() -> Self {
        Self {
            server: String::new(),
            username: String::new(),
            directory: "/".into(),
            sync_accounts: true,
            sync_settings: true,
            auto_sync: false,
        }
    }
}
#[derive(Serialize)]
pub struct ConfigView {
    config: DavConfig,
    password_saved: bool,
}
fn hash(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
fn config_file() -> Result<PathBuf> {
    Ok(auth::get_config_dir()?.join("webdav.json"))
}
fn load_config() -> Result<DavConfig> {
    let path = config_file()?;
    if !path.exists() {
        return Ok(DavConfig::default());
    }
    Ok(serde_json::from_slice(&auth::secure_file::read_limited(
        &path, 16384,
    )?)?)
}
fn base_url(config: &DavConfig) -> Result<Url> {
    let mut url = Url::parse(config.server.trim())
        .context("请输入完整的 WebDAV 地址 / Invalid WebDAV URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("WebDAV 地址只支持 HTTP/HTTPS；用户名和密码请分开填写 / Invalid WebDAV URL");
    }
    if !url.path().ends_with('/') {
        url.set_path(&format!("{}/", url.path()));
    }
    Ok(url)
}
fn normalized_directory(value: &str) -> Result<String> {
    let parts: Vec<_> = value.split('/').filter(|s| !s.is_empty()).collect();
    if value.len() > 2048
        || value.contains('\\')
        || value.chars().any(char::is_control)
        || parts.iter().any(|p| matches!(*p, "." | ".."))
    {
        bail!("无效的同步目录 / Invalid sync directory");
    }
    Ok(if parts.is_empty() {
        "/".into()
    } else {
        format!("/{}/", parts.join("/"))
    })
}
fn directory_url(config: &DavConfig, directory: &str) -> Result<Url> {
    let mut url = base_url(config)?;
    let path = normalized_directory(directory)?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| anyhow::anyhow!("Invalid WebDAV URL"))?;
        segments.pop_if_empty();
        for part in path.split('/').filter(|s| !s.is_empty()) {
            segments.push(part);
        }
        segments.push("");
    }
    Ok(url)
}
fn secret_entry(config: &DavConfig) -> Result<keyring::Entry> {
    let identity = hash(format!("{}\n{}", base_url(config)?, config.username).as_bytes());
    Ok(keyring::Entry::new(
        "com.duiwei996.codex-switcher-cn.webdav",
        &identity,
    )?)
}
fn password_for(
    config: &DavConfig,
    password: Option<String>,
) -> Result<zeroize::Zeroizing<String>> {
    if let Some(password) = password {
        return Ok(zeroize::Zeroizing::new(password));
    }
    match secret_entry(config)?.get_password() {
        Ok(password) => Ok(zeroize::Zeroizing::new(password)),
        Err(keyring::Error::NoEntry) if config.username.is_empty() => {
            Ok(zeroize::Zeroizing::new(String::new()))
        }
        Err(_) => bail!("请填写 WebDAV 密码 / Enter the WebDAV password"),
    }
}
fn client() -> Result<Client> {
    Ok(Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()?)
}
fn request(
    client: &Client,
    config: &DavConfig,
    password: &str,
    method: Method,
    url: Url,
) -> reqwest::RequestBuilder {
    client
        .request(method, url)
        .basic_auth(&config.username, Some(password))
        .header("Accept-Encoding", "identity")
}
async fn send(builder: reqwest::RequestBuilder) -> Result<reqwest::Response> {
    // Never expose a reqwest error containing a user's URL or response body.
    builder.send().await.map_err(|_| {
        anyhow::anyhow!(
            "WebDAV 网络请求失败，请检查地址、网络和证书 / WebDAV network request failed"
        )
    })
}
fn check_status(status: StatusCode) -> Result<()> {
    if status.is_success() {
        return Ok(());
    }
    bail!(match status.as_u16() {
        401 | 403 => "WebDAV 认证失败或没有权限 / WebDAV authentication or permission denied",
        404 => "WebDAV 目录不存在，请选择已有目录 / WebDAV directory not found",
        301 | 302 | 307 | 308 =>
            "WebDAV 地址发生重定向，请填写最终地址 / Enter the final WebDAV URL",
        412 => "云端文件已被其他设备修改，请重新同步 / Cloud changed; sync again",
        _ => "WebDAV 服务器返回错误 / WebDAV server error",
    })
}
async fn limited_body(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        bail!("WebDAV 文件过大 / WebDAV response too large");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("WebDAV 下载中断 / WebDAV download interrupted"))?
    {
        if bytes.len() + chunk.len() > limit {
            bail!("WebDAV 文件过大 / WebDAV response too large");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[tauri::command]
pub fn get_webdav_config() -> Result<ConfigView, String> {
    (|| -> Result<_> {
        let config = load_config()?;
        let password_saved =
            !config.server.is_empty() && secret_entry(&config)?.get_password().is_ok();
        Ok(ConfigView {
            config,
            password_saved,
        })
    })()
    .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn save_webdav_config(
    mut config: DavConfig,
    password: Option<String>,
) -> Result<ConfigView, String> {
    let _guard = SYNC_LOCK.lock().await;
    (|| -> Result<_> {
        config.server = base_url(&config)?.to_string();
        config.directory = normalized_directory(&config.directory)?;
        if config.username.len() > 1024 {
            bail!("WebDAV 用户名过长 / Username too long");
        }
        if let Some(password) = password {
            let password = zeroize::Zeroizing::new(password);
            secret_entry(&config)?
                .set_password(&password)
                .map_err(|_| {
                    anyhow::anyhow!(
                        "系统凭据库无法保存 WebDAV 密码 / Could not save WebDAV password"
                    )
                })?;
        }
        let _password = password_for(&config, None)?;
        auth::secure_file::atomic_write(&config_file()?, &serde_json::to_vec(&config)?)?;
        Ok(ConfigView {
            config,
            password_saved: true,
        })
    })()
    .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct MultiStatus {
    #[serde(rename = "response", default)]
    responses: Vec<DavResponse>,
}
#[derive(Deserialize)]
struct DavResponse {
    href: String,
    #[serde(rename = "propstat", default)]
    properties: Vec<PropStat>,
}
#[derive(Deserialize)]
struct PropStat {
    prop: DavProp,
    status: String,
}
#[derive(Deserialize)]
struct DavProp {
    #[serde(default)]
    resourcetype: ResourceType,
}
#[derive(Default, Deserialize)]
struct ResourceType {
    collection: Option<Collection>,
}
#[derive(Deserialize)]
struct Collection {}
#[derive(Serialize, Debug, PartialEq)]
pub struct DavDirectory {
    name: String,
    path: String,
}
fn parse_directories(xml: &[u8], root: &Url, current: &Url) -> Result<Vec<DavDirectory>> {
    let text =
        std::str::from_utf8(xml).context("WebDAV 目录编码无效 / Invalid WebDAV XML encoding")?;
    let multistatus: MultiStatus = quick_xml::de::from_str(text)
        .context("WebDAV 返回了无效目录列表 / Invalid WebDAV directory listing")?;
    let mut dirs = BTreeMap::new();
    for response in multistatus.responses {
        if !response.properties.iter().any(|p| {
            p.status.split_whitespace().nth(1) == Some("200")
                && p.prop.resourcetype.collection.is_some()
        }) {
            continue;
        }
        let url = current.join(&response.href)?;
        if url.origin() != root.origin()
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.path().starts_with(root.path())
        {
            continue;
        }
        let raw = url.path().trim_end_matches('/');
        let now = current.path().trim_end_matches('/');
        if raw == now || !raw.starts_with(&format!("{now}/")) {
            continue;
        }
        let child = &raw[now.len() + 1..];
        if child.is_empty() || child.contains('/') {
            continue;
        }
        let decoded = urlencoding::decode(child)?;
        if decoded.contains('/') || decoded.contains('\\') || matches!(decoded.as_ref(), "." | "..")
        {
            continue;
        }
        let relative =
            urlencoding::decode(url.path().strip_prefix(root.path()).unwrap_or_default())?;
        let path = normalized_directory(&relative)?;
        dirs.insert(
            path.clone(),
            DavDirectory {
                name: decoded.to_string(),
                path,
            },
        );
    }
    Ok(dirs.into_values().collect())
}
#[tauri::command]
pub async fn list_webdav_directories(
    config: DavConfig,
    password: Option<String>,
    directory: String,
) -> Result<Vec<DavDirectory>, String> {
    async { let password = password_for(&config, password)?;
        let url = directory_url(&config, &directory)?;
        let response = send(request(&client()?, &config, &password, Method::from_bytes(b"PROPFIND")?, url.clone())
            .header("Depth", "1").header("Content-Type", "application/xml; charset=utf-8")
            .body("<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/></d:prop></d:propfind>")).await?;
        check_status(response.status())?;
        if response.status() != StatusCode::MULTI_STATUS { bail!("服务器没有返回 WebDAV 目录列表 / Expected WebDAV multistatus"); }
        parse_directories(&limited_body(response, 2 * 1024 * 1024).await?, &base_url(&config)?, &url)
    }.await.map_err(|e: anyhow::Error| e.to_string())
}

#[derive(Default, Clone, Serialize, Deserialize, PartialEq, Debug)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    accounts: Option<Fields>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    settings: Option<Fields>,
}
fn empty_snapshot() -> Snapshot {
    Snapshot {
        version: 1,
        ..Default::default()
    }
}
fn encode(snapshot: &Snapshot) -> Result<Vec<u8>> {
    let raw = zeroize::Zeroizing::new(serde_json::to_vec(snapshot)?);
    if raw.len() > LIMIT {
        bail!("同步内容超过 8 MiB / Sync data exceeds 8 MiB");
    }
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&raw)?;
    Ok(encoder.finish()?)
}
fn decode(bytes: &[u8]) -> Result<Snapshot> {
    let mut raw = zeroize::Zeroizing::new(Vec::new());
    GzDecoder::new(bytes)
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut raw)
        .context("同步文件压缩格式无效 / Invalid compressed sync file")?;
    if raw.len() > LIMIT {
        bail!("同步内容超过 8 MiB / Sync data exceeds 8 MiB");
    }
    let snapshot: Snapshot =
        serde_json::from_slice(&raw).context("同步文件格式无效 / Invalid sync file")?;
    if snapshot.version != 1 {
        bail!("不支持的同步文件版本 / Unsupported sync version");
    }
    validate_snapshot(&snapshot)?;
    Ok(snapshot)
}
fn account_key(account: &StoredAccount) -> String {
    let identity = match &account.auth_data {
        AuthData::ApiKey { key } => format!("api:{key}"),
        AuthData::ChatGPT {
            account_id,
            id_token,
            ..
        } => format!(
            "chat:{}:{}",
            account
                .email
                .as_deref()
                .map(|s| s.trim().to_lowercase())
                .or_else(|| account_id.clone())
                .unwrap_or_else(|| id_token.clone()),
            account.plan_type.as_deref().unwrap_or("").to_lowercase()
        ),
    };
    hash(identity.as_bytes())
}
fn account_value(account: &StoredAccount, hidden: bool) -> Result<Value> {
    let updated_at = account
        .sync_updated_at
        .or(account.credentials_updated_at)
        .unwrap_or(account.created_at);
    Ok(
        json!({"name":account.name, "email":account.email, "plan_type":account.plan_type, "auth_mode":account.auth_mode,
        "credentials":{"auth_data":account.auth_data,"updated_at":account.credentials_updated_at}, "hidden":hidden,
        "updated_at":updated_at}),
    )
}
fn restore_account(value: &Value, old: Option<&StoredAccount>) -> Result<StoredAccount> {
    let mut data = value.as_object().cloned().context("Invalid sync account")?;
    let credentials = data
        .remove("credentials")
        .context("Missing sync credentials")?;
    data.remove("hidden");
    data.remove("cache");
    data.remove("updated_at");
    data.remove("field_updated_at");
    data.insert(
        "sync_updated_at".into(),
        value.get("updated_at").cloned().unwrap_or(Value::Null),
    );
    data.insert("auth_data".into(), credentials["auth_data"].clone());
    data.insert(
        "credentials_updated_at".into(),
        credentials["updated_at"].clone(),
    );
    data.insert(
        "id".into(),
        json!(old
            .map(|a| a.id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())),
    );
    data.insert(
        "created_at".into(),
        json!(old.map(|a| a.created_at).unwrap_or_else(chrono::Utc::now)),
    );
    data.insert(
        "last_used_at".into(),
        json!(old.and_then(|a| a.last_used_at)),
    );
    data.insert(
        "subscription_expires_at".into(),
        value
            .get("cache")
            .and_then(|c| c.get("metadata"))
            .and_then(|m| m.get("subscription_expires_at"))
            .cloned()
            .unwrap_or_else(|| json!(old.and_then(|a| a.subscription_expires_at))),
    );
    let same_credentials = old.is_some_and(|a| {
        serde_json::to_value(&a.auth_data).ok().as_ref() == Some(&credentials["auth_data"])
    });
    data.insert(
        "credentials_invalid".into(),
        json!(same_credentials && old.is_some_and(|a| a.credentials_invalid)),
    );
    let account: StoredAccount = serde_json::from_value(Value::Object(data))?;
    auth::validation::validate_account(&account)?;
    Ok(account)
}
const UI_KEYS: &[&str] = &[
    "theme",
    "language",
    "auto_warmup",
    "timed_warmup",
    "warmup_times",
];
fn validate_ui(ui: &Fields) -> Result<()> {
    for (key, value) in ui {
        let valid = match key.as_str() {
            "theme" => matches!(value.as_str(), Some("light" | "dark")),
            "language" => matches!(value.as_str(), Some("zh-CN" | "en-US")),
            "auto_warmup" | "timed_warmup" => value.is_boolean(),
            "warmup_times" => value.as_array().is_some_and(|times| {
                times.len() <= 96
                    && times.iter().all(|v| {
                        v.as_str().is_some_and(|s| {
                            s.len() == 5
                                && s.is_ascii()
                                && s.as_bytes()[2] == b':'
                                && s[..2].parse::<u8>().is_ok_and(|n| n < 24)
                                && s[3..].parse::<u8>().is_ok_and(|n| n < 60)
                        })
                    })
            }),
            _ => false,
        };
        if !valid {
            bail!("无效的同步设置 / Invalid synced preference");
        }
    }
    Ok(())
}
fn settings_fields(settings: &AppSettings, ui: &Fields) -> Result<Fields> {
    validate_ui(ui)?;
    let mut fields = ui.clone();
    let value = serde_json::to_value(settings)?;
    for key in [
        "automatic_update_checks",
        "refresh_scope",
        "refresh_interval_seconds",
        "account_switch_mode",
    ] {
        fields.insert(key.into(), value[key].clone());
    }
    Ok(fields)
}
fn validate_settings(fields: &Fields) -> Result<AppSettings> {
    let ui: Fields = fields
        .iter()
        .filter(|(k, _)| UI_KEYS.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    validate_ui(&ui)?;
    if fields.keys().any(|k| {
        !UI_KEYS.contains(&k.as_str())
            && ![
                "automatic_update_checks",
                "refresh_scope",
                "refresh_interval_seconds",
                "account_switch_mode",
            ]
            .contains(&k.as_str())
    }) {
        bail!("Unknown sync setting");
    }
    let settings: AppSettings = serde_json::from_value(json!(fields))?;
    if ![30, 60, 120, 300, 600].contains(&settings.refresh_interval_seconds) {
        bail!("Invalid sync refresh interval");
    }
    Ok(settings)
}
fn validate_snapshot(snapshot: &Snapshot) -> Result<()> {
    if let Some(accounts) = &snapshot.accounts {
        if accounts.len() > auth::validation::MAX_ACCOUNTS {
            bail!("同步账号超过 200 个 / Too many synced accounts");
        }
        for (key, value) in accounts {
            if let Some(cache) = value.get("cache") {
                serde_json::from_value::<AccountCache>(cache.clone())?.validate()?;
            }
            let account = restore_account(value, None)?;
            if &account_key(&account) != key || !value["hidden"].is_boolean() {
                bail!("Invalid sync account identity");
            }
        }
    }
    if let Some(fields) = &snapshot.settings {
        validate_settings(fields)?;
    }
    Ok(())
}
fn capture(
    store: &AccountsStore,
    settings: &AppSettings,
    ui: &Fields,
    config: &DavConfig,
) -> Result<Snapshot> {
    let accounts = if config.sync_accounts {
        let mut fields = Fields::new();
        for account in &store.accounts {
            if fields
                .insert(
                    account_key(account),
                    account_value(account, store.masked_account_ids.contains(&account.id))?,
                )
                .is_some()
            {
                bail!("本地存在重复账号，请先处理 / Duplicate local accounts");
            }
        }
        Some(fields)
    } else {
        None
    };
    Ok(Snapshot {
        version: 1,
        accounts,
        settings: if config.sync_settings {
            Some(settings_fields(settings, ui)?)
        } else {
            None
        },
    })
}
fn core_snapshot(snapshot: &Snapshot) -> Snapshot {
    Snapshot {
        accounts: snapshot.accounts.as_ref().map(|m| {
            m.iter()
                .map(|(k, v)| (k.clone(), quota_cache::without_cache(v)))
                .collect()
        }),
        ..snapshot.clone()
    }
}
fn attach_caches(
    snapshot: &mut Snapshot,
    store: &AccountsStore,
    caches: &BTreeMap<String, AccountCache>,
) -> Result<()> {
    let Some(values) = snapshot.accounts.as_mut() else {
        return Ok(());
    };
    if caches.len() > auth::validation::MAX_ACCOUNTS {
        bail!("Too many account caches");
    }
    for account in &store.accounts {
        let cache = caches.get(&account.id).cloned().unwrap_or_default();
        cache.validate()?;
        let fallback = AccountCache {
            metadata: account.subscription_expires_at.map(|date| MetadataCache {
                recorded_at: account.created_at,
                subscription_expires_at: Some(date),
            }),
            ..Default::default()
        };
        let cache = quota_cache::merge(&fallback, &cache);
        if !cache.is_empty() {
            if let Some(value) = values.get_mut(&account_key(account)) {
                value
                    .as_object_mut()
                    .context("Invalid account")?
                    .insert("cache".into(), serde_json::to_value(cache)?);
            }
        }
    }
    Ok(())
}
fn remap_caches(
    snapshot: &Snapshot,
    store: &AccountsStore,
) -> Result<BTreeMap<String, AccountCache>> {
    let mut result = BTreeMap::new();
    for account in &store.accounts {
        if let Some(value) = snapshot
            .accounts
            .as_ref()
            .and_then(|m| m.get(&account_key(account)))
            .and_then(|a| a.get("cache"))
        {
            let cache: AccountCache = serde_json::from_value(value.clone())?;
            cache.validate()?;
            result.insert(account.id.clone(), cache);
        }
    }
    Ok(result)
}
// Missing entries are deletions relative to the last successful sync, without unbounded tombstones.
fn merge_value(
    base: Option<&Value>,
    local: Option<&Value>,
    remote: Option<&Value>,
    choice: Option<&str>,
    path: &str,
    conflicts: &mut Vec<String>,
) -> Option<Value> {
    // An account missing on one side is retained from the side that still has it.
    // Absence alone cannot tell whether the deletion was intentional or accidental.
    let account = [base, local, remote]
        .into_iter()
        .flatten()
        .any(|value| value.get("credentials").is_some());
    if account {
        return match (local, remote) {
            (None, None) => None,
            (Some(value), None) | (None, Some(value)) => {
                finish_account_merge(value.clone(), local, remote)
            }
            (Some(local), Some(remote)) => {
                let local_content = comparable_account_data(local);
                let remote_content = comparable_account_data(remote);
                if local_content == remote_content {
                    let winner = match account_timestamp_order(local, remote) {
                        Some(std::cmp::Ordering::Greater) => local,
                        Some(std::cmp::Ordering::Less) => remote,
                        Some(std::cmp::Ordering::Equal) => local,
                        None if account_timestamp(local).is_some() => local,
                        None => remote,
                    };
                    return finish_account_merge(winner.clone(), Some(local), Some(remote));
                }

                let winner = match account_timestamp_order(local, remote) {
                    Some(std::cmp::Ordering::Greater) => Some(local),
                    Some(std::cmp::Ordering::Less) => Some(remote),
                    Some(std::cmp::Ordering::Equal) | None => match choice {
                        Some("local") => Some(local),
                        Some("remote") => Some(remote),
                        _ => None,
                    },
                };
                if winner.is_none() && conflicts.len() < 30 {
                    conflicts.push(path.to_string());
                }
                finish_account_merge(winner.unwrap_or(local).clone(), Some(local), Some(remote))
            }
        };
    }
    merge_core(base, local, remote, choice, path, conflicts)
}

fn timestamp_order(left: &Value, right: &Value) -> Option<std::cmp::Ordering> {
    match (left, right) {
        (Value::String(left), Value::String(right)) => {
            let left = chrono::DateTime::parse_from_rfc3339(left).ok()?;
            let right = chrono::DateTime::parse_from_rfc3339(right).ok()?;
            Some(left.cmp(&right))
        }
        (Value::Number(left), Value::Number(right)) => Some(left.as_i64()?.cmp(&right.as_i64()?)),
        _ => None,
    }
}

fn account_timestamp(account: &Value) -> Option<Value> {
    account
        .get("updated_at")
        .filter(|value| !value.is_null())
        .cloned()
        .or_else(|| {
            account
                .get("credentials")
                .and_then(|value| value.get("updated_at"))
                .filter(|value| !value.is_null())
                .cloned()
        })
}

fn account_timestamp_order(local: &Value, remote: &Value) -> Option<std::cmp::Ordering> {
    timestamp_order(&account_timestamp(local)?, &account_timestamp(remote)?)
}

fn comparable_account_data(value: &Value) -> Value {
    let mut comparable = quota_cache::without_cache(value);
    if let Value::Object(fields) = &mut comparable {
        fields.remove("updated_at");
        fields.remove("field_updated_at");
    }
    comparable
}

fn finish_account_merge(
    mut result: Value,
    local: Option<&Value>,
    remote: Option<&Value>,
) -> Option<Value> {
    if let Value::Object(map) = &mut result {
        map.remove("field_updated_at");
        if let Some(cache) = quota_cache::merged_value(
            local.and_then(|value| value.get("cache")),
            remote.and_then(|value| value.get("cache")),
        ) {
            map.insert("cache".into(), cache);
        }
    }
    Some(result)
}

fn merge_core(
    base: Option<&Value>,
    local: Option<&Value>,
    remote: Option<&Value>,
    choice: Option<&str>,
    path: &str,
    conflicts: &mut Vec<String>,
) -> Option<Value> {
    let recurse_objects = path != "credentials"
        && local.is_some_and(Value::is_object)
        && remote.is_some_and(Value::is_object);
    if !recurse_objects && (local == remote || remote == base) {
        return local.cloned();
    }
    if local == base && !recurse_objects {
        return remote.cloned();
    }
    if path != "credentials" {
        if let (Some(Value::Object(l)), Some(Value::Object(r))) = (local, remote) {
            let b = base.and_then(Value::as_object);
            let keys: BTreeSet<_> = l
                .keys()
                .chain(r.keys())
                .chain(b.into_iter().flat_map(|m| m.keys()))
                .collect();
            let mut result = serde_json::Map::new();
            for key in keys {
                if let Some(value) = merge_value(
                    b.and_then(|m| m.get(key)),
                    l.get(key),
                    r.get(key),
                    choice,
                    key,
                    conflicts,
                ) {
                    result.insert(key.clone(), value);
                }
            }
            return Some(Value::Object(result));
        }
    }
    match choice {
        Some("local") => local.cloned(),
        Some("remote") => remote.cloned(),
        _ => {
            if conflicts.len() < 30 {
                conflicts.push(path.to_string());
            }
            local.cloned()
        }
    }
}
fn merge_fields(
    base: &Option<Fields>,
    local: &Option<Fields>,
    remote: &Option<Fields>,
    choice: Option<&str>,
    conflicts: &mut Vec<String>,
) -> Option<Fields> {
    let to_value = |fields: &Option<Fields>| fields.as_ref().map(|v| json!(v));
    let (b, l, r) = (to_value(base), to_value(local), to_value(remote));
    merge_value(
        b.as_ref(),
        l.as_ref(),
        r.as_ref(),
        choice,
        "data",
        conflicts,
    )
    .map(|v| serde_json::from_value(v).expect("merged maps remain objects"))
}
fn baseline_file(config: &DavConfig) -> Result<PathBuf> {
    let identity = hash(
        format!(
            "{}\n{}",
            directory_url(config, &config.directory)?,
            config.username
        )
        .as_bytes(),
    );
    Ok(auth::get_config_dir()?.join(format!("webdav-baseline-{identity}.json")))
}
fn load_baseline(config: &DavConfig) -> Result<Snapshot> {
    let file = baseline_file(config)?;
    if !file.exists() {
        return Ok(empty_snapshot());
    }
    let bytes = auth::secure_file::read_limited(&file, (LIMIT * 2) as u64)?;
    let raw = auth::vault::decode(&bytes)?;
    Ok(serde_json::from_slice(&raw)?)
}
fn materialize_accounts(fields: &Fields, old: &AccountsStore) -> Result<AccountsStore> {
    let mut store = old.clone();
    store.accounts.clear();
    store.masked_account_ids.clear();
    for (key, value) in fields {
        let existing = old.accounts.iter().find(|a| account_key(a) == *key);
        let account = restore_account(value, existing)?;
        if value["hidden"] == true {
            store.masked_account_ids.push(account.id.clone());
        }
        store.accounts.push(account);
    }
    // Keep the local order and active selection. A remote deletion never writes CLI auth.json.
    store.accounts.sort_by_key(|a| {
        old.accounts
            .iter()
            .position(|b| a.id == b.id)
            .unwrap_or(usize::MAX)
    });
    if store
        .active_account_id
        .as_ref()
        .is_some_and(|id| !store.accounts.iter().any(|a| &a.id == id))
    {
        store.active_account_id = None;
    }
    auth::validation::validate_store(&store)?;
    Ok(store)
}
#[derive(Default, Clone, Copy, Serialize, Deserialize, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum SyncMode {
    #[default]
    Merge,
    Upload,
    Download,
}
#[derive(Default)]
struct SyncOptions {
    mode: SyncMode,
    choice: Option<String>,
    confirmation: Option<String>,
    automatic: bool,
}
#[derive(Default, Serialize, Debug)]
struct Changes {
    added: Vec<String>,
    updated: Vec<String>,
    deleted: Vec<String>,
    settings: Vec<String>,
    cache_updated: Vec<String>,
}
#[derive(Serialize, Debug)]
struct ConflictInfo {
    account: Option<String>,
    field: String,
}
#[derive(Serialize)]
struct SyncPreview {
    mode: SyncMode,
    choice: Option<String>,
    token: String,
    first_sync: bool,
    cloud_missing: bool,
    local_accounts: usize,
    cloud_accounts: usize,
    to_local: Changes,
    to_cloud: Changes,
    restored_accounts: Vec<String>,
    conflicts: Vec<ConflictInfo>,
}
#[derive(Serialize)]
pub struct SyncResult {
    pub conflicts: Vec<String>,
    bytes: usize,
    uploaded: bool,
    synced_at: String,
    ui: Option<Fields>,
    needs_confirmation: bool,
    preview: SyncPreview,
    recovery_path: Option<String>,
    account_caches: Option<BTreeMap<String, AccountCache>>,
}

fn changes(before: &Snapshot, after: &Snapshot, config: &DavConfig) -> Changes {
    let mut result = Changes::default();
    if config.sync_accounts {
        let empty = Fields::new();
        let b = before.accounts.as_ref().unwrap_or(&empty);
        let a = after.accounts.as_ref().unwrap_or(&empty);
        for (key, value) in a {
            let name = value["name"].as_str().unwrap_or("Account").to_owned();
            match b.get(key) {
                None => result.added.push(name),
                Some(old) => {
                    if comparable_account_data(old) != comparable_account_data(value) {
                        result.updated.push(name.clone());
                    }
                    if old.get("cache") != value.get("cache") {
                        result.cache_updated.push(name);
                    }
                }
            }
        }
        for (key, value) in b {
            if !a.contains_key(key) {
                result
                    .deleted
                    .push(value["name"].as_str().unwrap_or("Account").to_owned());
            }
        }
    }
    if config.sync_settings {
        let empty = Fields::new();
        let b = before.settings.as_ref().unwrap_or(&empty);
        let a = after.settings.as_ref().unwrap_or(&empty);
        for key in a.keys().chain(b.keys()).collect::<BTreeSet<_>>() {
            if a.get(key) != b.get(key) {
                result.settings.push(key.clone());
            }
        }
    }
    result
}
fn merged_snapshot(
    config: &DavConfig,
    baseline: &Snapshot,
    local: &Snapshot,
    remote: &Snapshot,
    options: &SyncOptions,
) -> Result<(Snapshot, Vec<String>, Vec<ConflictInfo>)> {
    let mut conflicts = Vec::new();
    let mut details = Vec::new();
    let mut merged = remote.clone();
    for (selected, base, l, r, target, accounts) in [
        (
            config.sync_accounts,
            &baseline.accounts,
            &local.accounts,
            &remote.accounts,
            &mut merged.accounts,
            true,
        ),
        (
            config.sync_settings,
            &baseline.settings,
            &local.settings,
            &remote.settings,
            &mut merged.settings,
            false,
        ),
    ] {
        if !selected {
            continue;
        }
        *target = match options.mode {
            SyncMode::Upload => l.clone(),
            SyncMode::Download => Some(
                r.clone()
                    .context("云端没有所选内容，已停止下载 / Cloud has no selected content")?,
            ),
            SyncMode::Merge => {
                // Describe conflicts with account names and field names, never credential values.
                let empty = Fields::new();
                let b = base.as_ref().unwrap_or(&empty);
                let lv = l.as_ref().unwrap_or(&empty);
                let rv = r.as_ref().unwrap_or(&empty);
                for key in b
                    .keys()
                    .chain(lv.keys())
                    .chain(rv.keys())
                    .collect::<BTreeSet<_>>()
                {
                    let mut paths = Vec::new();
                    merge_value(b.get(key), lv.get(key), rv.get(key), None, key, &mut paths);
                    for field in paths {
                        details.push(ConflictInfo {
                            account: if accounts {
                                lv.get(key)
                                    .or_else(|| rv.get(key))
                                    .and_then(|v| v["name"].as_str())
                                    .map(str::to_owned)
                            } else {
                                None
                            },
                            field: if accounts && field == *key {
                                "account".into()
                            } else {
                                field
                            },
                        });
                    }
                }
                merge_fields(base, l, r, options.choice.as_deref(), &mut conflicts)
            }
        };
    }
    // Observations always keep the newest section, including during one-way operations.
    if config.sync_accounts {
        if let Some(accounts) = merged.accounts.as_mut() {
            for (key, value) in accounts {
                let l = local
                    .accounts
                    .as_ref()
                    .and_then(|m| m.get(key))
                    .and_then(|v| v.get("cache"));
                let r = remote
                    .accounts
                    .as_ref()
                    .and_then(|m| m.get(key))
                    .and_then(|v| v.get("cache"));
                if let Some(cache) = quota_cache::merged_value(l, r) {
                    value
                        .as_object_mut()
                        .context("Invalid account cache")?
                        .insert("cache".into(), cache);
                }
            }
        }
    }
    Ok((merged, conflicts, details))
}
fn preview(
    config: &DavConfig,
    baseline: &Snapshot,
    local: &Snapshot,
    remote: &Snapshot,
    merged: &Snapshot,
    missing: bool,
    etag: Option<&str>,
    options: &SyncOptions,
    conflicts: Vec<ConflictInfo>,
) -> Result<SyncPreview> {
    let restored_accounts = if options.mode == SyncMode::Merge && config.sync_accounts {
        let empty = Fields::new();
        let baseline_accounts = baseline.accounts.as_ref().unwrap_or(&empty);
        let local_accounts = local.accounts.as_ref().unwrap_or(&empty);
        let remote_accounts = remote.accounts.as_ref().unwrap_or(&empty);
        let merged_accounts = merged.accounts.as_ref().unwrap_or(&empty);
        baseline_accounts
            .keys()
            .filter(|key| {
                local_accounts.contains_key(*key) != remote_accounts.contains_key(*key)
                    && merged_accounts.contains_key(*key)
            })
            .filter_map(|key| {
                merged_accounts
                    .get(key)
                    .and_then(|account| account.get("name"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .collect()
    } else {
        Vec::new()
    };
    let token = hash(&serde_json::to_vec(
        &json!({"config":config,"local":core_snapshot(local),"remote":remote,"baseline":core_snapshot(baseline),"merged":core_snapshot(merged),"etag":etag,"mode":options.mode,"choice":options.choice,"missing":missing}),
    )?);
    Ok(SyncPreview {
        mode: options.mode,
        choice: options.choice.clone(),
        token,
        first_sync: (config.sync_accounts && baseline.accounts.is_none())
            || (config.sync_settings && baseline.settings.is_none()),
        cloud_missing: missing,
        local_accounts: local.accounts.as_ref().map_or(0, Fields::len),
        cloud_accounts: remote.accounts.as_ref().map_or(0, Fields::len),
        to_local: changes(local, merged, config),
        to_cloud: if options.mode == SyncMode::Download {
            Changes::default()
        } else {
            changes(remote, merged, config)
        },
        restored_accounts,
        conflicts,
    })
}
fn requires_review(plan: &SyncPreview) -> bool {
    plan.first_sync
        || plan.mode != SyncMode::Merge
        || !plan.to_local.deleted.is_empty()
        || !plan.to_cloud.deleted.is_empty()
        || !plan.restored_accounts.is_empty()
        || !plan.conflicts.is_empty()
}
fn confirmed(plan: &SyncPreview, options: &SyncOptions) -> bool {
    !options.automatic && options.confirmation.as_deref() == Some(plan.token.as_str())
}
#[derive(Serialize, Deserialize)]
struct Recovery {
    version: u32,
    saved_at: String,
    mode: SyncMode,
    local: Snapshot,
    cloud: Snapshot,
    baseline: Snapshot,
}
fn save_recovery(
    config: &DavConfig,
    local: &Snapshot,
    cloud: &Snapshot,
    baseline: &Snapshot,
    mode: SyncMode,
) -> Result<String> {
    let path = baseline_file(config)?.with_file_name(format!(
        "webdav-recovery-{}.json",
        hash(
            format!(
                "{}\n{}",
                directory_url(config, &config.directory)?,
                config.username
            )
            .as_bytes()
        )
    ));
    let recovery = Recovery {
        version: 1,
        saved_at: chrono::Utc::now().to_rfc3339(),
        mode,
        local: local.clone(),
        cloud: cloud.clone(),
        baseline: baseline.clone(),
    };
    let raw = zeroize::Zeroizing::new(serde_json::to_vec(&recovery)?);
    auth::secure_file::atomic_write(&path, &auth::vault::encode(&raw, true)?)?;
    Ok(path.to_string_lossy().into_owned())
}

async fn sync_inner(
    config: &DavConfig,
    ui: Fields,
    options: SyncOptions,
    account_caches: BTreeMap<String, AccountCache>,
    app: Option<&tauri::AppHandle>,
) -> Result<SyncResult> {
    if !config.sync_accounts && !config.sync_settings {
        bail!("请至少选择一项同步内容 / Select at least one sync option");
    }
    if options
        .choice
        .as_deref()
        .is_some_and(|c| c != "local" && c != "remote")
    {
        bail!("Invalid conflict choice");
    }
    if options.automatic && (options.mode != SyncMode::Merge || options.choice.is_some()) {
        bail!("覆盖和冲突选择须手动执行 / Overrides require manual action");
    }
    let password = password_for(config, None)?;
    let client = client()?;
    let url = directory_url(config, &config.directory)?.join(FILE)?;
    let response = send(request(
        &client,
        config,
        &password,
        Method::GET,
        url.clone(),
    ))
    .await?;
    let missing = response.status() == StatusCode::NOT_FOUND;
    if !missing {
        check_status(response.status())?;
    }
    let etag = response
        .headers()
        .get("etag")
        .and_then(|h| h.to_str().ok())
        .map(str::to_owned);
    let remote_bytes = if missing {
        Vec::new()
    } else {
        limited_body(response, LIMIT).await?
    };
    let remote = if missing {
        empty_snapshot()
    } else {
        decode(&remote_bytes)?
    };
    if missing && options.mode == SyncMode::Download {
        bail!("云端没有同步文件，无法下载 / Cloud sync file not found");
    }
    // The auth lock serializes refresh/switch with the complete merge. The store lock remains short.
    let _auth = auth::AUTH_OPERATION_LOCK.lock().await;
    let _files = auth::lock_auth_files().await?;
    let mut store = if config.sync_accounts {
        auth::load_accounts()?
    } else {
        AccountsStore::default()
    };
    if config.sync_accounts {
        if let Some(live) = auth::read_current_auth()? {
            auth::sync_active_account_tokens(&mut store, &live);
        }
    }
    let settings = auth::load_app_settings()?;
    let mut local = capture(&store, &settings, &ui, config)?;
    attach_caches(&mut local, &store, &account_caches)?;
    let mut baseline = load_baseline(config)?;
    // Recreating a removed cloud file must not interpret its absence as deleting every local account.
    if missing {
        baseline = empty_snapshot();
    }
    let (merged, conflicts, details) =
        merged_snapshot(config, &baseline, &local, &remote, &options)?;
    let plan = preview(
        config,
        &baseline,
        &local,
        &remote,
        &merged,
        missing,
        etag.as_deref(),
        &options,
        details,
    )?;
    let review = requires_review(&plan) || options.choice.is_some();
    if !conflicts.is_empty()
        || ((review || options.confirmation.is_some()) && !confirmed(&plan, &options))
    {
        return Ok(SyncResult {
            conflicts,
            bytes: remote_bytes.len(),
            uploaded: false,
            synced_at: String::new(),
            ui: None,
            needs_confirmation: true,
            preview: plan,
            recovery_path: None,
            account_caches: None,
        });
    }
    validate_snapshot(&merged)?;
    let next_store = if config.sync_accounts
        && options.mode != SyncMode::Upload
        && local.accounts != merged.accounts
    {
        Some(materialize_accounts(
            merged.accounts.as_ref().context("Missing accounts")?,
            &store,
        )?)
    } else {
        None
    };
    let next_settings = if config.sync_settings
        && options.mode != SyncMode::Upload
        && local.settings != merged.settings
    {
        Some(validate_settings(
            merged.settings.as_ref().context("Missing settings")?,
        )?)
    } else {
        None
    };
    let bytes = encode(&merged)?;
    let recovery_path = if review {
        Some(save_recovery(
            config,
            &local,
            &remote,
            &baseline,
            options.mode,
        )?)
    } else {
        None
    };
    let uploaded = options.mode != SyncMode::Download && (missing || merged != remote);
    if uploaded {
        upload_verified(
            &client,
            config,
            &password,
            url,
            missing,
            etag.as_deref(),
            &bytes,
            &merged,
        )
        .await?;
    }
    let result_caches = if config.sync_accounts && options.mode != SyncMode::Upload {
        Some(remap_caches(
            &merged,
            next_store.as_ref().unwrap_or(&store),
        )?)
    } else {
        None
    };
    if let Some(next) = next_store {
        auth::update_accounts(|current| {
            if let Some(live) = auth::read_current_auth()? {
                auth::sync_active_account_tokens(current, &live);
            }
            if capture(current, &settings, &ui, config)?.accounts != core_snapshot(&local).accounts
                || current.accounts.iter().any(|a| {
                    store
                        .accounts
                        .iter()
                        .find(|old| old.id == a.id)
                        .is_some_and(|old| old.subscription_expires_at != a.subscription_expires_at)
                })
            {
                bail!("同步期间本地账号发生变化，请重试 / Local accounts changed; retry");
            }
            *current = next;
            Ok(())
        })?;
    }
    if let Some(next) = next_settings {
        auth::update_app_settings(|current| {
            if settings_fields(current, &ui)? != local.settings.clone().unwrap_or_default() {
                bail!("同步期间本地设置发生变化，请重试 / Local settings changed; retry");
            }
            current.automatic_update_checks = next.automatic_update_checks;
            current.refresh_scope = next.refresh_scope;
            current.refresh_interval_seconds = next.refresh_interval_seconds;
            current.account_switch_mode = next.account_switch_mode;
            Ok(())
        })?;
    }
    if config.sync_accounts {
        baseline.accounts = merged.accounts.clone();
    }
    if config.sync_settings {
        baseline.settings = merged.settings.clone();
    }
    let raw = zeroize::Zeroizing::new(serde_json::to_vec(&baseline)?);
    auth::secure_file::atomic_write(&baseline_file(config)?, &auth::vault::encode(&raw, true)?)?;
    if let Some(app) = app {
        if config.sync_accounts
            && (!plan.to_local.added.is_empty()
                || !plan.to_local.updated.is_empty()
                || !plan.to_local.deleted.is_empty())
        {
            let _ = app.emit("accounts-changed", ());
        }
        if config.sync_settings && !plan.to_local.settings.is_empty() {
            let _ = app.emit("app-settings-changed", ());
        }
    }
    let result_ui = if config.sync_settings && options.mode != SyncMode::Upload {
        merged.settings.map(|fields| {
            fields
                .into_iter()
                .filter(|(k, _)| UI_KEYS.contains(&k.as_str()))
                .collect()
        })
    } else {
        None
    };
    Ok(SyncResult {
        conflicts: Vec::new(),
        bytes: if uploaded {
            bytes.len()
        } else {
            remote_bytes.len()
        },
        uploaded,
        synced_at: chrono::Utc::now().to_rfc3339(),
        ui: result_ui,
        needs_confirmation: false,
        preview: plan,
        recovery_path,
        account_caches: result_caches,
    })
}

async fn upload_verified(
    client: &Client,
    config: &DavConfig,
    password: &str,
    url: Url,
    missing: bool,
    etag: Option<&str>,
    bytes: &[u8],
    snapshot: &Snapshot,
) -> Result<()> {
    let mut builder = request(client, config, password, Method::PUT, url.clone())
        .header("Content-Type", "application/gzip")
        .body(bytes.to_vec());
    if missing {
        builder = builder.header("If-None-Match", "*");
    } else {
        let tag = etag.filter(|t| !t.starts_with("W/") && t.starts_with('"') && t.ends_with('"')).context("服务器未提供强 ETag，已停止上传以避免覆盖 / Server lacks a strong ETag; upload stopped")?;
        builder = builder.header("If-Match", tag);
    }
    let response = send(builder).await?;
    check_status(response.status())?;
    let check = send(request(client, config, password, Method::GET, url)).await?;
    check_status(check.status())?;
    if decode(&limited_body(check, LIMIT).await?)? != *snapshot {
        bail!("云端回读内容已变化，请重新同步 / Cloud verification changed; sync again");
    }
    Ok(())
}
#[tauri::command]
pub async fn sync_webdav(
    app: tauri::AppHandle,
    ui: Fields,
    choice: Option<String>,
    mode: Option<SyncMode>,
    confirmation: Option<String>,
    automatic: Option<bool>,
    account_caches: Option<BTreeMap<String, AccountCache>>,
) -> Result<SyncResult, String> {
    let _guard = SYNC_LOCK
        .try_lock()
        .map_err(|_| "正在同步，请稍候 / Sync already running")?;
    let config = load_config().map_err(|e| e.to_string())?;
    sync_inner(
        &config,
        ui,
        SyncOptions {
            mode: mode.unwrap_or_default(),
            choice,
            confirmation,
            automatic: automatic.unwrap_or(false),
        },
        account_caches.unwrap_or_default(),
        Some(&app),
    )
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_cache(stamp: &str, used: f64) -> AccountCache {
        serde_json::from_value(json!({"metadata":{"recorded_at":stamp,"subscription_expires_at":"2030-12-01T00:00:00Z"},"usage":{"recorded_at":stamp,"primary_used_percent":used,"primary_window_minutes":300,"primary_resets_at":1900000000,"secondary_used_percent":used,"secondary_window_minutes":10080,"secondary_resets_at":1900100000,"has_credits":true,"unlimited_credits":false,"credits_balance":"10"},"resets":{"recorded_at":stamp,"credits":[{"id":"synthetic-credit","expires_at":"2030-12-01T00:00:00Z","title":"Reset"}]}})).unwrap()
    }
    #[test]
    fn cache_sections_keep_the_newest_atomic_observation_and_empty_reset_results() {
        let mut local = test_cache("2026-10-19T12:00:00Z", 10.0);
        let mut cloud = test_cache("2026-10-19T11:00:00Z", 90.0);
        cloud.resets.as_mut().unwrap().recorded_at = "2026-10-19T13:00:00Z".parse().unwrap();
        cloud.resets.as_mut().unwrap().credits.clear();
        local.metadata.as_mut().unwrap().recorded_at = "2026-10-19T10:00:00Z".parse().unwrap();
        let merged = quota_cache::merge(&local, &cloud);
        assert_eq!(merged.usage, local.usage);
        assert_eq!(merged.metadata, cloud.metadata);
        assert!(merged.resets.unwrap().credits.is_empty());
        let a = test_cache("2026-10-19T12:00:00Z", 10.0);
        let b = test_cache("2026-10-19T12:00:00Z", 20.0);
        assert_eq!(quota_cache::merge(&a, &b), quota_cache::merge(&b, &a));
    }
    #[test]
    fn cache_refreshes_do_not_conflict_and_missing_accounts_keep_the_remaining_copy() {
        let account = StoredAccount::new_api_key("Cache account".into(), "synthetic-key".into());
        let key = account_key(&account);
        let mut base = account_value(&account, false).unwrap();
        base["cache"] = json!(test_cache("2026-10-19T10:00:00Z", 1.0));
        let mut local = base.clone();
        local["cache"] = json!(test_cache("2026-10-19T12:00:00Z", 20.0));
        let mut remote = base.clone();
        remote["cache"] = json!(test_cache("2026-10-19T11:00:00Z", 50.0));
        let mut conflicts = vec![];
        let merged = merge_value(
            Some(&base),
            Some(&local),
            Some(&remote),
            None,
            &key,
            &mut conflicts,
        )
        .unwrap();
        assert!(conflicts.is_empty());
        assert_eq!(merged["cache"], local["cache"]);
        assert_eq!(
            merge_value(Some(&base), None, Some(&remote), None, &key, &mut conflicts),
            Some(remote)
        );
        assert_eq!(
            merge_value(Some(&base), Some(&local), None, None, &key, &mut conflicts),
            Some(local)
        );
        assert!(conflicts.is_empty());
    }
    #[test]
    fn missing_accounts_on_either_side_are_restored_only_after_review() {
        let config = DavConfig::default();
        let account = StoredAccount::new_api_key("Keep account".into(), "synthetic-key".into());
        let baseline = Snapshot {
            version: 1,
            accounts: fields(json!({"a": account_value(&account, false).unwrap()})),
            settings: None,
        };
        let missing = Snapshot {
            accounts: Some(Fields::new()),
            ..baseline.clone()
        };
        for (local, remote) in [(&missing, &baseline), (&baseline, &missing)] {
            let options = SyncOptions::default();
            let (merged, conflicts, details) =
                merged_snapshot(&config, &baseline, local, remote, &options).unwrap();
            assert!(conflicts.is_empty() && details.is_empty());
            assert_eq!(merged.accounts, baseline.accounts);
            let plan = preview(
                &config,
                &baseline,
                local,
                remote,
                &merged,
                false,
                Some("\"v1\""),
                &options,
                details,
            )
            .unwrap();
            assert_eq!(plan.restored_accounts, vec!["Keep account"]);
            assert!(requires_review(&plan));
            assert!(!confirmed(&plan, &options));
            assert!(plan.to_local.deleted.is_empty() && plan.to_cloud.deleted.is_empty());
            assert_eq!(plan.to_local.added.len() + plan.to_cloud.added.len(), 1);
        }
    }
    #[test]
    fn cache_remaps_to_each_devices_uuid_and_restores_subscription_expiry() {
        let source = StoredAccount::new_api_key("Portable".into(), "synthetic-portable-key".into());
        let mut target = source.clone();
        target.id = uuid::Uuid::new_v4().to_string();
        let store = AccountsStore {
            accounts: vec![source.clone()],
            ..Default::default()
        };
        let mut snapshot = capture(
            &store,
            &AppSettings::default(),
            &Fields::new(),
            &DavConfig::default(),
        )
        .unwrap();
        let cache = test_cache("2026-10-19T12:00:00Z", 24.0);
        attach_caches(
            &mut snapshot,
            &store,
            &BTreeMap::from([(source.id.clone(), cache.clone())]),
        )
        .unwrap();
        assert_eq!(decode(&encode(&snapshot).unwrap()).unwrap(), snapshot);
        let other = AccountsStore {
            accounts: vec![target.clone()],
            ..Default::default()
        };
        let mapped = remap_caches(&snapshot, &other).unwrap();
        assert_eq!(mapped.get(&target.id), Some(&cache));
        assert!(!mapped.contains_key(&source.id));
        let materialized =
            materialize_accounts(snapshot.accounts.as_ref().unwrap(), &other).unwrap();
        assert_eq!(
            materialized.accounts[0].subscription_expires_at,
            cache.metadata.unwrap().subscription_expires_at
        );
    }
    #[test]
    fn cache_only_updates_are_counted_separately_and_do_not_invalidate_local_confirmation() {
        let account = StoredAccount::new_api_key("Cache".into(), "synthetic-key".into());
        let store = AccountsStore {
            accounts: vec![account.clone()],
            ..Default::default()
        };
        let config = DavConfig::default();
        let base = capture(&store, &AppSettings::default(), &Fields::new(), &config).unwrap();
        let mut local = base.clone();
        attach_caches(
            &mut local,
            &store,
            &BTreeMap::from([(account.id.clone(), test_cache("2026-10-19T12:00:00Z", 1.0))]),
        )
        .unwrap();
        let (merged, conflicts, details) =
            merged_snapshot(&config, &base, &local, &base, &SyncOptions::default()).unwrap();
        assert!(conflicts.is_empty() && details.is_empty());
        let plan = preview(
            &config,
            &base,
            &local,
            &base,
            &merged,
            false,
            Some("\"v1\""),
            &SyncOptions::default(),
            vec![],
        )
        .unwrap();
        assert!(!requires_review(&plan));
        assert!(plan.to_cloud.updated.is_empty());
        assert_eq!(plan.to_cloud.cache_updated, vec!["Cache"]);
        let mut later = local.clone();
        attach_caches(
            &mut later,
            &store,
            &BTreeMap::from([(account.id.clone(), test_cache("2026-10-19T13:00:00Z", 2.0))]),
        )
        .unwrap();
        let plan2 = preview(
            &config,
            &base,
            &later,
            &base,
            &later,
            false,
            Some("\"v1\""),
            &SyncOptions::default(),
            vec![],
        )
        .unwrap();
        assert_eq!(plan.token, plan2.token);
    }
    #[test]
    fn quota_wire_rejects_statistics_credentials_and_invalid_data() {
        let cache = test_cache("2026-10-19T12:00:00Z", 1.0);
        cache.validate().unwrap();
        for field in ["daily", "summary", "access_token"] {
            let mut value = json!(cache);
            value[field] = json!("forbidden");
            assert!(serde_json::from_value::<AccountCache>(value).is_err());
        }
        let mut bad = cache.clone();
        bad.usage.as_mut().unwrap().primary_used_percent = Some(-1.0);
        assert!(bad.validate().is_err());
        let mut bad = cache.clone();
        let duplicate = bad.resets.as_ref().unwrap().credits[0].clone();
        bad.resets.as_mut().unwrap().credits.push(duplicate);
        assert!(bad.validate().is_err());
        let mut value = json!(cache);
        value["usage"]["recorded_at"] = json!("invalid date");
        assert!(serde_json::from_value::<AccountCache>(value).is_err());
    }

    #[test]
    fn directional_modes_replace_only_selected_sections_and_download_requires_cloud_content() {
        let mut config = DavConfig::default();
        config.sync_settings = false;
        let local = Snapshot {
            version: 1,
            accounts: fields(json!({"local":{"name":"Local"}})),
            settings: fields(json!({"theme":"dark"})),
        };
        let remote = Snapshot {
            version: 1,
            accounts: fields(json!({"cloud":{"name":"Cloud"}})),
            settings: fields(json!({"theme":"light"})),
        };
        let upload = SyncOptions {
            mode: SyncMode::Upload,
            ..Default::default()
        };
        let (merged, conflicts, _) =
            merged_snapshot(&config, &empty_snapshot(), &local, &remote, &upload).unwrap();
        assert_eq!(merged.accounts, local.accounts);
        assert_eq!(merged.settings, remote.settings);
        assert!(conflicts.is_empty());
        let download = SyncOptions {
            mode: SyncMode::Download,
            ..Default::default()
        };
        let (merged, _, _) =
            merged_snapshot(&config, &empty_snapshot(), &local, &remote, &download).unwrap();
        assert_eq!(merged.accounts, remote.accounts);
        let plan = preview(
            &config,
            &local,
            &local,
            &remote,
            &merged,
            false,
            Some("\"v1\""),
            &download,
            vec![],
        )
        .unwrap();
        assert_eq!(plan.to_local.added, vec!["Cloud"]);
        assert_eq!(plan.to_local.deleted, vec!["Local"]);
        assert!(plan.to_cloud.added.is_empty() && plan.to_cloud.deleted.is_empty());
        assert!(requires_review(&plan));
        assert!(merged_snapshot(&config, &local, &local, &empty_snapshot(), &download).is_err());
        config.sync_accounts = false;
        config.sync_settings = true;
        let (merged, _, _) =
            merged_snapshot(&config, &empty_snapshot(), &local, &remote, &upload).unwrap();
        assert_eq!(merged.accounts, remote.accounts);
        assert_eq!(merged.settings, local.settings);
    }
    #[test]
    fn first_sync_and_deletions_require_review_but_routine_updates_do_not() {
        let config = DavConfig::default();
        let local = Snapshot {
            version: 1,
            accounts: fields(json!({"a":{"name":"A"}})),
            settings: fields(json!({"theme":"light"})),
        };
        let options = SyncOptions::default();
        let plan = preview(
            &config,
            &empty_snapshot(),
            &local,
            &empty_snapshot(),
            &local,
            true,
            None,
            &options,
            vec![],
        )
        .unwrap();
        assert!(plan.first_sync && plan.cloud_missing && requires_review(&plan));
        assert_eq!(plan.to_cloud.added, vec!["A"]);
        let updated = Snapshot {
            settings: fields(json!({"theme":"dark"})),
            ..local.clone()
        };
        let plan = preview(
            &config,
            &local,
            &local,
            &updated,
            &updated,
            false,
            Some("\"v1\""),
            &options,
            vec![],
        )
        .unwrap();
        assert!(!requires_review(&plan));
        assert_eq!(plan.to_local.settings, vec!["theme"]);
        let deleted = Snapshot {
            accounts: Some(Fields::new()),
            ..local.clone()
        };
        let plan = preview(
            &config,
            &local,
            &local,
            &deleted,
            &deleted,
            false,
            Some("\"v2\""),
            &options,
            vec![],
        )
        .unwrap();
        assert!(requires_review(&plan));
        assert_eq!(plan.to_local.deleted, vec!["A"]);
    }
    #[test]
    fn confirmation_is_bound_to_data_scope_direction_and_cloud_revision() {
        let config = DavConfig::default();
        let data = empty_snapshot();
        let mut options = SyncOptions::default();
        let original = preview(
            &config,
            &data,
            &data,
            &data,
            &data,
            false,
            Some("\"v1\""),
            &options,
            vec![],
        )
        .unwrap();
        assert!(!confirmed(&original, &options));
        options.confirmation = Some(original.token.clone());
        assert!(confirmed(&original, &options));
        options.automatic = true;
        assert!(!confirmed(&original, &options));
        options.automatic = false;
        let changed = Snapshot {
            settings: fields(json!({"theme":"dark"})),
            ..empty_snapshot()
        };
        let stale = preview(
            &config,
            &data,
            &changed,
            &data,
            &changed,
            false,
            Some("\"v1\""),
            &options,
            vec![],
        )
        .unwrap();
        assert!(!confirmed(&stale, &options));
        let stale = preview(
            &config,
            &data,
            &data,
            &data,
            &data,
            false,
            Some("\"v2\""),
            &options,
            vec![],
        )
        .unwrap();
        assert!(!confirmed(&stale, &options));
        options.mode = SyncMode::Upload;
        let stale = preview(
            &config,
            &data,
            &data,
            &data,
            &data,
            false,
            Some("\"v1\""),
            &options,
            vec![],
        )
        .unwrap();
        assert!(!confirmed(&stale, &options));
        options.mode = SyncMode::Merge;
        let config = DavConfig {
            sync_settings: false,
            ..config
        };
        let stale = preview(
            &config,
            &data,
            &data,
            &data,
            &data,
            false,
            Some("\"v1\""),
            &options,
            vec![],
        )
        .unwrap();
        assert!(!confirmed(&stale, &options));
    }
    #[test]
    fn conflict_descriptions_expose_names_and_fields_without_credential_values() {
        let config = DavConfig::default();
        let snapshot = |name: &str, token: &str| Snapshot {
            version: 1,
            accounts: fields(
                json!({"account-key":{"name":name,"credentials":{"auth_data":token,"updated_at":null}}}),
            ),
            settings: None,
        };
        let base = snapshot("Account A", "synthetic-old");
        let local = snapshot("Account A", "synthetic-local");
        let remote = snapshot("Account A", "synthetic-cloud");
        let (_, conflicts, details) =
            merged_snapshot(&config, &base, &local, &remote, &SyncOptions::default()).unwrap();
        assert_eq!(conflicts, vec!["account-key"]);
        assert_eq!(details[0].account.as_deref(), Some("Account A"));
        assert_eq!(details[0].field, "account");
        assert!(!serde_json::to_string(&details)
            .unwrap()
            .contains("synthetic"));
        let (_, conflicts, details) = merged_snapshot(
            &config,
            &base,
            &local,
            &remote,
            &SyncOptions {
                choice: Some("remote".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(conflicts.is_empty());
        assert_eq!(details.len(), 1);
    }
    #[test]
    fn recovery_contains_both_pre_operation_snapshots_and_baseline() {
        let local = Snapshot {
            version: 1,
            accounts: fields(json!({"local":{"name":"Local"}})),
            settings: None,
        };
        let cloud = Snapshot {
            version: 1,
            accounts: fields(json!({"cloud":{"name":"Cloud"}})),
            settings: None,
        };
        let backup = Recovery {
            version: 1,
            saved_at: chrono::Utc::now().to_rfc3339(),
            mode: SyncMode::Upload,
            local: local.clone(),
            cloud: cloud.clone(),
            baseline: empty_snapshot(),
        };
        let restored: Recovery =
            serde_json::from_slice(&serde_json::to_vec(&backup).unwrap()).unwrap();
        assert_eq!(restored.local, local);
        assert_eq!(restored.cloud, cloud);
        assert_eq!(restored.baseline, empty_snapshot());
        assert_eq!(restored.mode, SyncMode::Upload);
    }

    fn fields(value: Value) -> Option<Fields> {
        Some(serde_json::from_value(value).unwrap())
    }
    fn merge(
        base: Value,
        local: Value,
        remote: Value,
        choice: Option<&str>,
    ) -> (Value, Vec<String>) {
        let mut conflicts = Vec::new();
        let value = merge_fields(
            &fields(base),
            &fields(local),
            &fields(remote),
            choice,
            &mut conflicts,
        );
        (json!(value), conflicts)
    }
    #[test]
    fn three_way_merge_preserves_independent_changes_and_deletions() {
        let (value, conflicts) = merge(
            json!({"a":{"name":"before","hidden":false},"b":1}),
            json!({"a":{"name":"after","hidden":false}}),
            json!({"a":{"name":"before","hidden":true},"b":1,"c":3}),
            None,
        );
        assert!(conflicts.is_empty());
        assert_eq!(value, json!({"a":{"name":"after","hidden":true},"c":3}));
        // An unchanged offline device must accept a remote deletion instead of resurrecting it.
        assert_eq!(
            merge(json!({"a":1}), json!({"a":1}), json!({}), None).0,
            json!({})
        );
    }
    #[test]
    fn conflicts_pause_and_resolve_only_conflicting_fields() {
        let base = json!({"name":"old","hidden":false});
        let local = json!({"name":"local","hidden":false});
        let remote = json!({"name":"remote","hidden":true});
        assert_eq!(
            merge(base.clone(), local.clone(), remote.clone(), None).1,
            vec!["name"]
        );
        assert_eq!(
            merge(base.clone(), local.clone(), remote.clone(), Some("local")).0,
            json!({"name":"local","hidden":true})
        );
        assert_eq!(merge(base, local, remote.clone(), Some("remote")).0, remote);
        assert!(!merge(json!({"a":1}), json!({}), json!({"a":2}), None)
            .1
            .is_empty());
    }
    #[test]
    fn credentials_merge_as_a_unit_and_first_sync_unions_accounts() {
        let (value, conflicts) = merge(
            json!({"credentials":{"auth_data":"old","updated_at":1}}),
            json!({"credentials":{"auth_data":"local","updated_at":2}}),
            json!({"credentials":{"auth_data":"remote","updated_at":3}}),
            Some("remote"),
        );
        assert!(conflicts.is_empty());
        assert_eq!(
            value,
            json!({"credentials":{"auth_data":"remote","updated_at":3}})
        );
        let mut conflicts = vec![];
        assert_eq!(
            merge_fields(
                &None,
                &fields(json!({"a":1})),
                &fields(json!({"b":2})),
                None,
                &mut conflicts
            ),
            fields(json!({"a":1,"b":2}))
        );
        assert!(conflicts.is_empty());
    }
    #[test]
    fn newer_account_timestamp_wins_even_if_a_choice_is_supplied() {
        let local = json!({"account":{"credentials":{"auth_data":"new","updated_at":"2026-10-16T10:00:00Z"}}});
        let remote = json!({"account":{"credentials":{"auth_data":"old","updated_at":"2026-10-15T10:00:00Z"}}});
        let (merged, conflicts) = merge(local.clone(), local.clone(), remote.clone(), None);
        assert!(conflicts.is_empty());
        assert_eq!(merged, local);
        assert_eq!(
            merge(local.clone(), local.clone(), remote.clone(), Some("remote")).0,
            local
        );
    }
    #[test]
    fn account_timestamp_selects_a_whole_copy_and_equal_times_require_a_choice() {
        let local = json!({"a":{"name":"Local", "hidden":false, "updated_at":"2026-10-22T12:00:00Z", "credentials":{"auth_data":"local", "updated_at":"2026-10-20T12:00:00Z"}}});
        let remote = json!({"a":{"name":"Remote", "hidden":true, "updated_at":"2026-10-21T12:00:00Z", "credentials":{"auth_data":"remote", "updated_at":"2026-10-21T12:00:00Z"}}});
        let (merged, conflicts) = merge(json!({}), local.clone(), remote.clone(), Some("remote"));
        assert!(conflicts.is_empty());
        assert_eq!(merged, local);
        let mut equal_time = remote;
        equal_time["a"]["updated_at"] = local["a"]["updated_at"].clone();
        assert_eq!(
            merge(json!({}), local.clone(), equal_time.clone(), None).1,
            vec!["a"]
        );
        assert_eq!(
            merge(json!({}), local, equal_time.clone(), Some("remote")).0,
            equal_time
        );
    }
    #[test]
    fn account_roundtrip_preserves_local_selection_and_does_not_sync_local_metadata() {
        let mut account =
            StoredAccount::new_api_key("my account".into(), "public-synthetic-key".into());
        account.credentials_invalid = true;
        account.last_used_at = Some(chrono::Utc::now());
        let mut store = AccountsStore::default();
        store.active_account_id = Some(account.id.clone());
        store.accounts.push(account.clone());
        store.masked_account_ids.push(account.id.clone());
        let snapshot = capture(
            &store,
            &AppSettings::default(),
            &Fields::new(),
            &DavConfig::default(),
        )
        .unwrap();
        let bytes = encode(&snapshot).unwrap();
        assert_eq!(decode(&bytes).unwrap(), snapshot);
        let raw = serde_json::to_string(&snapshot).unwrap();
        for excluded in [
            "last_used_at",
            "active_account_id",
            "credentials_invalid",
            "autostart",
            "startup_minimized",
            "dock_display_mode",
            "username",
            "password",
        ] {
            assert!(!raw.contains(excluded));
        }
        let next = materialize_accounts(snapshot.accounts.as_ref().unwrap(), &store).unwrap();
        assert_eq!(next.active_account_id, store.active_account_id);
        assert_eq!(next.masked_account_ids, store.masked_account_ids);
        assert_eq!(next.accounts[0].last_used_at, account.last_used_at);
        assert!(next.accounts[0].credentials_invalid);
        let other_device = materialize_accounts(
            snapshot.accounts.as_ref().unwrap(),
            &AccountsStore::default(),
        )
        .unwrap();
        assert_ne!(other_device.accounts[0].id, account.id);
        assert_eq!(
            account_key(&other_device.accounts[0]),
            account_key(&account)
        );
        assert!(other_device.active_account_id.is_none());
    }
    #[test]
    fn options_are_independent_and_settings_are_allowlisted() {
        let settings = AppSettings::default();
        let ui = serde_json::from_value(json!({"theme":"dark","language":"en-US","auto_warmup":true,"timed_warmup":false,"warmup_times":["09:30"]})).unwrap();
        let mut config = DavConfig::default();
        config.sync_accounts = false;
        let snapshot = capture(&AccountsStore::default(), &settings, &ui, &config).unwrap();
        assert!(snapshot.accounts.is_none());
        assert!(snapshot.settings.is_some());
        let bytes = encode(&snapshot).unwrap();
        assert!(bytes.len() < 1024);
        config.sync_accounts = true;
        config.sync_settings = false;
        assert!(capture(&AccountsStore::default(), &settings, &ui, &config)
            .unwrap()
            .settings
            .is_none());
        assert!(validate_settings(
            &serde_json::from_value(json!({"password":"forbidden"})).unwrap()
        )
        .is_err());
        assert!(
            validate_ui(&serde_json::from_value(json!({"warmup_times":["中ab"]})).unwrap())
                .is_err()
        );
        assert!(
            validate_ui(&serde_json::from_value(json!({"warmup_times":["25:00"]})).unwrap())
                .is_err()
        );
        assert!(validate_settings(
            &serde_json::from_value(json!({"refresh_interval_seconds":1})).unwrap()
        )
        .is_err());
    }
    #[test]
    fn malformed_oversized_and_future_snapshots_are_rejected() {
        assert!(decode(b"not gzip").is_err());
        let mut snapshot = empty_snapshot();
        snapshot.version = 2;
        assert!(decode(&encode(&snapshot).unwrap()).is_err());
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&vec![b' '; LIMIT + 1]).unwrap();
        assert!(decode(&encoder.finish().unwrap()).is_err());
        let mut snapshot = empty_snapshot();
        snapshot.accounts = fields(json!({"bad":{"name":"bad"}}));
        assert!(decode(&encode(&snapshot).unwrap()).is_err());
    }
    #[test]
    fn directory_urls_stay_below_the_configured_endpoint() {
        let config = DavConfig {
            server: "https://example.com/dav/".into(),
            ..Default::default()
        };
        assert_eq!(
            directory_url(&config, "/中文/space # &/").unwrap().as_str(),
            "https://example.com/dav/%E4%B8%AD%E6%96%87/space%20%23%20&/"
        );
        assert!(directory_url(&config, "/../outside").is_err());
        assert!(directory_url(&config, "/a\\b").is_err());
        assert!(base_url(&DavConfig {
            server: "https://user:secret@example.com".into(),
            ..Default::default()
        })
        .is_err());
    }
    #[test]
    fn directory_listing_handles_namespaces_escapes_files_and_boundaries() {
        let root = Url::parse("https://example.com/dav/").unwrap();
        let xml = br#"<d:multistatus xmlns:d="DAV:">
          <d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
          <d:response><d:href>/dav/a%20%26%20b/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
          <d:response><d:href>/dav/file.json</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
          <d:response><d:href>https://other.example.com/dav/evil/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
          <d:response><d:href>/outside/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
          <d:response><d:href>/dav/denied/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response>
        </d:multistatus>"#;
        assert_eq!(
            parse_directories(xml, &root, &root).unwrap(),
            vec![DavDirectory {
                name: "a & b".into(),
                path: "/a & b/".into()
            }]
        );
    }
    #[tokio::test]
    async fn mock_webdav_checks_create_update_conflict_and_roundtrip() {
        use tiny_http::{Header, Response, Server};
        let server = Server::http("127.0.0.1:0").unwrap();
        let config = DavConfig {
            server: format!("http://{}/dav/", server.server_addr()),
            ..Default::default()
        };
        let url = directory_url(&config, "/").unwrap().join(FILE).unwrap();
        let snapshot = Snapshot {
            version: 1,
            accounts: Some(Fields::new()),
            settings: None,
        };
        let bytes = encode(&snapshot).unwrap();
        let expected = bytes.clone();
        let worker = std::thread::spawn(move || {
            for (header, tag) in [("If-None-Match", "*"), ("If-Match", "\"v1\"")] {
                let mut put = server
                    .recv_timeout(Duration::from_secs(10))
                    .unwrap()
                    .unwrap();
                assert_eq!(put.method().as_str(), "PUT");
                assert_eq!(put.url(), "/dav/accounts.sync.gz");
                assert!(put
                    .headers()
                    .iter()
                    .any(|h| h.field.equiv(header) && h.value.as_str() == tag));
                let mut body = Vec::new();
                put.as_reader().read_to_end(&mut body).unwrap();
                assert_eq!(body, expected);
                put.respond(Response::empty(201)).unwrap();
                let get = server
                    .recv_timeout(Duration::from_secs(10))
                    .unwrap()
                    .unwrap();
                assert_eq!(get.method().as_str(), "GET");
                get.respond(
                    Response::from_data(expected.clone())
                        .with_header(Header::from_bytes("ETag", "\"v1\"").unwrap()),
                )
                .unwrap();
            }
            let conflict = server
                .recv_timeout(Duration::from_secs(10))
                .unwrap()
                .unwrap();
            conflict.respond(Response::empty(412)).unwrap();
        });
        let client = client().unwrap();
        upload_verified(
            &client,
            &config,
            "public-test-password",
            url.clone(),
            true,
            None,
            &bytes,
            &snapshot,
        )
        .await
        .unwrap();
        upload_verified(
            &client,
            &config,
            "public-test-password",
            url.clone(),
            false,
            Some("\"v1\""),
            &bytes,
            &snapshot,
        )
        .await
        .unwrap();
        assert!(upload_verified(
            &client,
            &config,
            "public-test-password",
            url.clone(),
            false,
            None,
            &bytes,
            &snapshot
        )
        .await
        .is_err());
        assert!(upload_verified(
            &client,
            &config,
            "public-test-password",
            url.clone(),
            false,
            Some("W/\"weak\""),
            &bytes,
            &snapshot
        )
        .await
        .is_err());
        assert!(upload_verified(
            &client,
            &config,
            "public-test-password",
            url,
            false,
            Some("\"v1\""),
            &bytes,
            &snapshot
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("Cloud changed"));
        worker.join().unwrap();
    }
    #[tokio::test]
    async fn redirects_are_not_followed_and_error_bodies_are_not_exposed() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let config = DavConfig {
            server: format!("http://{}/", server.server_addr()),
            ..Default::default()
        };
        let worker = std::thread::spawn(move || {
            let request = server
                .recv_timeout(Duration::from_secs(10))
                .unwrap()
                .unwrap();
            request
                .respond(
                    tiny_http::Response::from_string("private-server-error")
                        .with_status_code(302)
                        .with_header(
                            tiny_http::Header::from_bytes("Location", "https://other.example.com/")
                                .unwrap(),
                        ),
                )
                .unwrap();
        });
        let response = send(request(
            &client().unwrap(),
            &config,
            "public-test-password",
            Method::GET,
            base_url(&config).unwrap(),
        ))
        .await
        .unwrap();
        let error = check_status(response.status()).unwrap_err().to_string();
        assert!(error.contains("final WebDAV URL"));
        assert!(!error.contains("private-server-error"));
        worker.join().unwrap();
    }
    #[test]
    fn synthetic_login_snapshot_size_report() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        use rand::RngCore;
        let mut store = AccountsStore::default();
        for count in 1..=100 {
            let token = || {
                let mut bytes = vec![0u8; 2048];
                rand::rng().fill_bytes(&mut bytes);
                format!("e30.{}.synthetic", URL_SAFE_NO_PAD.encode(bytes))
            };
            store.accounts.push(StoredAccount::new_chatgpt(
                format!("account-{count}"),
                Some(format!("{count}@example.com")),
                Some("plus".into()),
                None,
                token(),
                token(),
                format!("public-synthetic-refresh-{count}"),
                Some(format!("account-{count}")),
            ));
            if [1, 10, 100].contains(&count) {
                let snapshot = capture(
                    &store,
                    &AppSettings::default(),
                    &Fields::new(),
                    &DavConfig::default(),
                )
                .unwrap();
                println!(
                    "SYNTHETIC_SIZE accounts={count} raw={} gzip={}",
                    serde_json::to_vec(&snapshot).unwrap().len(),
                    encode(&snapshot).unwrap().len()
                );
                let mut cached = snapshot.clone();
                let caches = store
                    .accounts
                    .iter()
                    .enumerate()
                    .map(|(i, a)| {
                        let mut cache = test_cache("2026-10-19T12:00:00Z", (i % 100) as f64);
                        cache.usage.as_mut().unwrap().primary_resets_at =
                            Some(1900000000 + i as i64 * 137);
                        cache.resets.as_mut().unwrap().credits[0].id =
                            format!("synthetic-credit-{i}");
                        (a.id.clone(), cache)
                    })
                    .collect();
                attach_caches(&mut cached, &store, &caches).unwrap();
                println!(
                    "SYNTHETIC_CACHED_SIZE accounts={count} raw={} gzip={}",
                    serde_json::to_vec(&cached).unwrap().len(),
                    encode(&cached).unwrap().len()
                );
            }
        }
    }
}
