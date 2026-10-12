use std::path::{Component, Path, PathBuf};

use crate::commands::{
    add_account_from_auth_json_text, delete_account, fetch_usage, get_account_usage_stats,
    get_active_account_info, get_masked_account_ids, list_accounts, refresh_account_metadata,
    refresh_all_accounts_usage, rename_account, set_masked_account_ids, switch_account,
};
use anyhow::Context;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::runtime::Runtime;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountIdArgs {
    #[serde(alias = "account_id")]
    account_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameAccountArgs {
    #[serde(alias = "account_id")]
    account_id: String,
    #[serde(alias = "new_name")]
    new_name: String,
}

#[derive(Deserialize)]
struct MaskedIdsArgs {
    ids: Vec<String>,
}
#[derive(Deserialize)]
struct UploadAuthJsonArgs {
    name: String,
    contents: String,
}

#[derive(Clone)]
struct WebState {
    token: std::sync::Arc<zeroize::Zeroizing<String>>,
    root: PathBuf,
    authority: String,
    allow_writes: bool,
    slots: std::sync::Arc<tokio::sync::Semaphore>,
}
pub fn run_lan_server(host: &str, port: u16, token: &str) -> anyhow::Result<()> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("dist")
        .canonicalize()
        .context("Build the frontend before starting web mode")?;
    let local = matches!(host, "localhost" | "127.0.0.1" | "::1");
    let address = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let state = WebState {
        token: std::sync::Arc::new(zeroize::Zeroizing::new(token.to_owned())),
        root,
        authority: address.clone(),
        allow_writes: local
            && std::env::var("CODEX_SWITCHER_WEB_ALLOW_ACCOUNT_WRITES").as_deref() == Ok("1"),
        slots: std::sync::Arc::new(tokio::sync::Semaphore::new(4)),
    };
    Runtime::new()?.block_on(async move {
        let listener = tokio::net::TcpListener::bind(&address).await?;
        println!(
            "Web dashboard listening on http://{address}; account writes require local opt-in"
        );
        axum::serve(
            listener,
            axum::Router::new().fallback(web_request).with_state(state),
        )
        .await?;
        Ok(())
    })
}
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |diff, (&a, &b)| diff | (a ^ b))
        == 0
}
fn json_reply(status: axum::http::StatusCode, value: Value) -> axum::response::Response {
    use axum::response::IntoResponse;
    (status, axum::Json(value)).into_response()
}
async fn web_request(
    axum::extract::State(state): axum::extract::State<WebState>,
    request: axum::extract::Request,
) -> axum::response::Response {
    let response = match state.slots.clone().try_acquire_owned() {
        Ok(_slot) => match tokio::time::timeout(
            std::time::Duration::from_secs(35),
            web_request_inner(state, request),
        )
        .await
        {
            Ok(response) => response,
            Err(_) => json_reply(
                axum::http::StatusCode::REQUEST_TIMEOUT,
                json!({"error":"Request timed out"}),
            ),
        },
        Err(_) => json_reply(
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            json!({"error":"Server busy; retry later"}),
        ),
    };
    let mut response = response;
    let headers = response.headers_mut();
    for (name, value) in [("cache-control", "no-store"), ("x-content-type-options", "nosniff"), ("x-frame-options", "DENY"), ("referrer-policy", "no-referrer"), ("content-security-policy", "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")] {
        headers.insert(axum::http::HeaderName::from_static(name), axum::http::HeaderValue::from_static(value));
    }
    response
}
async fn web_request_inner(
    state: WebState,
    request: axum::extract::Request,
) -> axum::response::Response {
    use axum::{http::StatusCode as Status, response::IntoResponse};
    let authority = request
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let local_alias = matches!(
        state.authority.split(':').next(),
        Some("127.0.0.1" | "localhost")
    ) && authority.split(':').last() == state.authority.split(':').last()
        && matches!(authority.split(':').next(), Some("127.0.0.1" | "localhost"));
    if authority != state.authority && !local_alias {
        return json_reply(Status::FORBIDDEN, json!({"error":"Untrusted host"}));
    }
    if let Some(origin) = request.headers().get("origin") {
        let same_origin = origin.to_str().ok().is_some_and(|origin| {
            origin == format!("http://{authority}") || origin == format!("https://{authority}")
        });
        if !same_origin {
            return json_reply(
                Status::FORBIDDEN,
                json!({"error":"Cross-origin request blocked"}),
            );
        }
    }
    let path = request.uri().path().to_owned();
    if request.method() == axum::http::Method::GET && path == "/api/health" {
        return json_reply(Status::OK, json!({"ok":true}));
    }
    if let Some(command) = path.strip_prefix("/api/invoke/") {
        if request.method() != axum::http::Method::POST {
            return json_reply(Status::METHOD_NOT_ALLOWED, json!({"error":"Use POST"}));
        }
        let authorized = request
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .is_some_and(|v| constant_time_eq(v.as_bytes(), state.token.as_bytes()));
        if !authorized {
            return json_reply(
                Status::UNAUTHORIZED,
                json!({"error":"Invalid or missing API access token"}),
            );
        }
        if command == "web_capabilities" {
            return json_reply(Status::OK, json!({"readOnly":!state.allow_writes}));
        }
        if !web_command_allowed(command, state.allow_writes) {
            return json_reply(
                Status::FORBIDDEN,
                json!({"error":"This operation is available in the desktop app; web mode is read-only by default"}),
            );
        }
        let body = match axum::body::to_bytes(request.into_body(), 1024 * 1024).await {
            Ok(body) => body,
            Err(_) => {
                return json_reply(
                    Status::PAYLOAD_TOO_LARGE,
                    json!({"error":"Invalid or oversized request body"}),
                )
            }
        };
        let payload = if body.is_empty() {
            json!({})
        } else {
            match serde_json::from_slice(&body) {
                Ok(value) => value,
                Err(_) => return json_reply(Status::BAD_REQUEST, json!({"error":"Invalid JSON"})),
            }
        };
        return match invoke_web_command(command, payload).await {
            Ok(value) => json_reply(Status::OK, value),
            Err(error) => json_reply(Status::BAD_REQUEST, json!({"error":error})),
        };
    }
    if request.method() != axum::http::Method::GET {
        return Status::METHOD_NOT_ALLOWED.into_response();
    }
    let requested = match sanitize_path(&path) {
        Ok(path) => path,
        Err(_) => return Status::BAD_REQUEST.into_response(),
    };
    let mut candidate = state.root.join(&requested);
    if requested.as_os_str().is_empty() || (!candidate.is_file() && requested.extension().is_none())
    {
        candidate = state.root.join("index.html");
    }
    let canonical = match candidate.canonicalize() {
        Ok(path) if path.starts_with(&state.root) => path,
        _ => return Status::NOT_FOUND.into_response(),
    };
    let mime = mime_type_for_path(&canonical);
    match tokio::task::spawn_blocking(move || {
        crate::auth::secure_file::read_limited(&canonical, 8 * 1024 * 1024)
    })
    .await
    {
        Ok(Ok(data)) => ([(axum::http::header::CONTENT_TYPE, mime)], data).into_response(),
        _ => Status::NOT_FOUND.into_response(),
    }
}
fn web_command_allowed(command: &str, allow_writes: bool) -> bool {
    matches!(
        command,
        "list_accounts"
            | "get_active_account_info"
            | "get_usage"
            | "get_account_usage_stats"
            | "refresh_account_metadata"
            | "refresh_all_accounts_usage"
            | "get_masked_account_ids"
            | "get_display_settings"
    ) || (allow_writes
        && matches!(
            command,
            "rename_account"
                | "delete_account"
                | "switch_account"
                | "set_masked_account_ids"
                | "set_account_switch_mode"
                | "add_account_from_auth_json_text"
        ))
}

async fn invoke_web_command(command: &str, payload: Value) -> Result<Value, String> {
    match command {
        "list_accounts" => to_json(list_accounts().await?),
        "get_active_account_info" => to_json(get_active_account_info().await?),
        "add_account_from_auth_json_text" => {
            let args: UploadAuthJsonArgs = parse_args(payload)?;
            to_json(add_account_from_auth_json_text(args.name, args.contents).await?)
        }
        "get_usage" => {
            let args: AccountIdArgs = parse_args(payload)?;
            to_json(fetch_usage(&args.account_id).await?)
        }
        "get_account_usage_stats" => {
            let args: AccountIdArgs = parse_args(payload)?;
            to_json(get_account_usage_stats(args.account_id).await?)
        }
        "refresh_account_metadata" => {
            let args: AccountIdArgs = parse_args(payload)?;
            to_json(refresh_account_metadata(args.account_id).await?)
        }
        "refresh_all_accounts_usage" => to_json(refresh_all_accounts_usage().await?),
        "get_display_settings" => to_json(crate::commands::get_display_settings()?),
        "set_account_switch_mode" => {
            #[derive(Deserialize)]
            struct Args {
                mode: crate::types::AccountSwitchMode,
            }
            let args: Args = parse_args(payload)?;
            to_json(crate::commands::set_account_switch_mode(args.mode)?)
        }
        "switch_account" => {
            let args: AccountIdArgs = parse_args(payload)?;
            to_json(switch_account(args.account_id, None).await?)
        }
        "delete_account" => {
            let args: AccountIdArgs = parse_args(payload)?;
            to_json(delete_account(args.account_id).await?)
        }
        "rename_account" => {
            let args: RenameAccountArgs = parse_args(payload)?;
            to_json(rename_account(args.account_id, args.new_name).await?)
        }
        "get_masked_account_ids" => to_json(get_masked_account_ids().await?),
        "set_masked_account_ids" => {
            let args: MaskedIdsArgs = parse_args(payload)?;
            to_json(set_masked_account_ids(args.ids).await?)
        }
        _ => Err("Unsupported web command".into()),
    }
}

fn parse_args<T>(value: Value) -> Result<T, String>
where
    T: DeserializeOwned,
{
    serde_json::from_value(value).map_err(|error| format!("Invalid command payload: {error}"))
}

fn to_json<T>(value: T) -> Result<Value, String>
where
    T: serde::Serialize,
{
    serde_json::to_value(value).map_err(|error| format!("Failed to serialize response: {error}"))
}

fn sanitize_path(url: &str) -> anyhow::Result<PathBuf> {
    let path = url.split('?').next().unwrap_or("/");
    let raw = path.trim_start_matches('/');
    if raw.contains(':') || raw.contains('\\') {
        anyhow::bail!("Invalid request path");
    }
    let candidate = Path::new(raw);

    for component in candidate.components() {
        match component {
            Component::Normal(_) => {}
            _ => anyhow::bail!("Invalid request path"),
        }
    }

    Ok(candidate.to_path_buf())
}

fn mime_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "css" => "text/css; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "ico" => "image/x-icon",
        "jpeg" | "jpg" => "image/jpeg",
        "js" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "txt" => "text/plain; charset=utf-8",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod web_security_tests {
    use super::*;

    #[test]
    fn token_equal_and_mismatched() {
        assert!(constant_time_eq(
            b"example-secret-aaaaaaaaaaaaaaaaaaaaaaaa",
            b"example-secret-aaaaaaaaaaaaaaaaaaaaaaaa"
        ));
        assert!(!constant_time_eq(
            b"example-secret-aaaaaaaaaaaaaaaaaaaaaaaa",
            b"example-secret-aaaaaaaaaaaaaaaaaaaaaaab"
        ));
        assert!(!constant_time_eq(b"short", b"longer"));
    }

    #[test]
    fn blocks_paths_and_sensitive_commands_even_with_write_opt_in() {
        for path in ["/../secret", "/C:/secret", "/asset:secret", "/a\\b"] {
            assert!(sanitize_path(path).is_err());
        }
        for command in [
            "add_account_from_file",
            "kill_codex_processes",
            "export_accounts_json",
            "save_accounts_json",
            "import_accounts_json",
            "import_accounts_json_files",
            "start_login",
        ] {
            assert!(!web_command_allowed(command, true));
        }
        assert!(!web_command_allowed("delete_account", false));
        assert!(web_command_allowed("rename_account", true));
        assert!(web_command_allowed("get_usage", false));
    }

    #[tokio::test]
    async fn rejects_bad_bearer_cross_origin_and_read_only_writes_before_accessing_accounts() {
        use axum::{
            body::Body,
            http::{Request, StatusCode},
        };
        let dir = tempfile::tempdir().unwrap();
        let state = WebState {
            token: std::sync::Arc::new(zeroize::Zeroizing::new("a".repeat(32))),
            root: dir.path().to_owned(),
            authority: "127.0.0.1:3210".into(),
            allow_writes: false,
            slots: std::sync::Arc::new(tokio::sync::Semaphore::new(4)),
        };
        let request = Request::builder()
            .method("POST")
            .uri("/api/invoke/list_accounts")
            .header("host", "127.0.0.1:3210")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            web_request_inner(state.clone(), request).await.status(),
            StatusCode::UNAUTHORIZED
        );
        let request = Request::builder()
            .method("POST")
            .uri("/api/invoke/delete_account")
            .header("host", "127.0.0.1:3210")
            .header("authorization", format!("Bearer {}", "a".repeat(32)))
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            web_request_inner(state.clone(), request).await.status(),
            StatusCode::FORBIDDEN
        );
        let request = Request::builder()
            .uri("/api/health")
            .header("host", "127.0.0.1:3210")
            .header("origin", "https://example.com")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            web_request_inner(state, request).await.status(),
            StatusCode::FORBIDDEN
        );
    }
}
