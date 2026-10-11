//! OAuth login commands with cancellable, serialized pending flows.
use crate::auth::oauth_server::{start_oauth_login, wait_for_oauth_login, OAuthLoginResult};
use crate::auth::{add_account, load_accounts};
use crate::types::{AccountInfo, OAuthLoginInfo};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex};
struct PendingOAuth {
    id: uuid::Uuid,
    rx: Option<oneshot::Receiver<anyhow::Result<OAuthLoginResult>>>,
    cancelled: Arc<AtomicBool>,
}
static PENDING_OAUTH: Mutex<Option<PendingOAuth>> = Mutex::const_new(None);
#[tauri::command]
pub async fn start_login(account_name: String) -> Result<OAuthLoginInfo, String> {
    crate::auth::validation::validate_optional_name(&account_name).map_err(|e| e.to_string())?;
    let mut pending = PENDING_OAUTH.lock().await;
    if let Some(previous) = pending.take() {
        previous.cancelled.store(true, Ordering::SeqCst);
    }
    let (info, rx, cancelled) = start_oauth_login(account_name.trim().into())
        .await
        .map_err(|e| e.to_string())?;
    *pending = Some(PendingOAuth {
        id: uuid::Uuid::new_v4(),
        rx: Some(rx),
        cancelled,
    });
    Ok(info)
}
#[tauri::command]
pub async fn complete_login() -> Result<AccountInfo, String> {
    let (id, rx, cancelled) = {
        let mut state = PENDING_OAUTH.lock().await;
        let pending = state.as_mut().ok_or("No pending OAuth login")?;
        (
            pending.id,
            pending
                .rx
                .take()
                .ok_or("Login completion already waiting")?,
            pending.cancelled.clone(),
        )
    };
    let result = wait_for_oauth_login(rx).await;
    let mut state = PENDING_OAUTH.lock().await;
    if cancelled.load(Ordering::SeqCst) || state.as_ref().map(|p| p.id) != Some(id) {
        return Err("OAuth login cancelled".into());
    }
    *state = None;
    let account = result.map_err(|e| e.to_string())?;
    let stored = add_account(account).map_err(|e| e.to_string())?;
    // Saving a login must not bypass the normal process check and switching transaction.
    // When Codex is running, retain the new account as inactive for a later explicit switch.
    if crate::commands::ensure_codex_not_running().is_ok() {
        crate::commands::switch_account_by_id(&stored.id).await?;
    }
    let store = load_accounts().map_err(|e| e.to_string())?;
    Ok(AccountInfo::from_stored(
        &stored,
        store.active_account_id.as_deref(),
    ))
}
#[tauri::command]
pub async fn cancel_login() -> Result<(), String> {
    if let Some(pending) = PENDING_OAUTH.lock().await.take() {
        pending.cancelled.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn blank_login_name_generates_a_link_without_authenticating() {
        let info = start_login(String::new())
            .await
            .expect("blank name should start login");
        let url = url::Url::parse(&info.auth_url).expect("valid authorize URL");
        assert_eq!(url.scheme(), "https");
        assert!(info.callback_port > 0);
        cancel_login().await.unwrap();
        assert!(complete_login().await.is_err());
    }
}
