//! Account management Tauri commands

use crate::auth::{
    add_account, ensure_chatgpt_tokens_fresh_locked, get_active_account, import_from_auth_json,
    import_from_auth_json_contents, load_accounts, read_current_auth, switch_to_account,
    sync_active_account_tokens, update_accounts, AUTH_OPERATION_LOCK,
};
use crate::types::{AccountInfo, AccountSwitchMode};

use super::process::ensure_codex_not_running;

use anyhow::Context;
/// List all accounts with their info
#[tauri::command]
pub async fn list_accounts() -> Result<Vec<AccountInfo>, String> {
    let store = load_accounts().map_err(|e| e.to_string())?;
    let active_id = store.active_account_id.as_deref();

    let accounts: Vec<AccountInfo> = store
        .accounts
        .iter()
        .map(|a| {
            let mut info = AccountInfo::from_stored(a, active_id);
            super::usage::apply_cached_account_metadata(&mut info);
            info
        })
        .collect();

    Ok(accounts)
}

/// Get the currently active account
#[tauri::command]
pub async fn get_active_account_info() -> Result<Option<AccountInfo>, String> {
    let store = load_accounts().map_err(|e| e.to_string())?;
    let active_id = store.active_account_id.as_deref();

    if let Some(active) = get_active_account().map_err(|e| e.to_string())? {
        let mut info = AccountInfo::from_stored(&active, active_id);
        super::usage::apply_cached_account_metadata(&mut info);
        Ok(Some(info))
    } else {
        Ok(None)
    }
}

/// Add an account from an auth.json file
#[tauri::command]
pub async fn add_account_from_file(path: String, name: String) -> Result<AccountInfo, String> {
    // Import from the file
    let account = import_from_auth_json(&path, name).map_err(|e| e.to_string())?;

    // Add to storage
    let stored = add_account(account).map_err(|e| e.to_string())?;

    let store = load_accounts().map_err(|e| e.to_string())?;
    let active_id = store.active_account_id.as_deref();

    Ok(AccountInfo::from_stored(&stored, active_id))
}

/// Add an account from uploaded auth.json contents.
pub async fn add_account_from_auth_json_text(
    name: String,
    contents: String,
) -> Result<AccountInfo, String> {
    let account = import_from_auth_json_contents(&contents, name).map_err(|e| e.to_string())?;
    let stored = add_account(account).map_err(|e| e.to_string())?;

    let store = load_accounts().map_err(|e| e.to_string())?;
    let active_id = store.active_account_id.as_deref();

    Ok(AccountInfo::from_stored(&stored, active_id))
}

/// Switch to a different account
#[tauri::command]
pub async fn switch_account(account_id: String, allow_running: Option<bool>) -> Result<(), String> {
    switch_account_with_policy(&account_id, allow_running, false).await
}

/// Reapply saved credentials even if metadata still marks this account as active.
#[tauri::command]
pub async fn restart_account(account_id: String) -> Result<(), String> {
    switch_account_with_policy(&account_id, None, true).await
}

pub async fn switch_account_by_id(account_id: &str) -> Result<(), String> {
    switch_account_with_policy(account_id, None, false).await
}

async fn switch_account_with_policy(
    account_id: &str,
    allow_running: Option<bool>,
    restart: bool,
) -> Result<(), String> {
    let _auth_guard = AUTH_OPERATION_LOCK.lock().await;
    let mode = crate::auth::load_app_settings()
        .map_err(|e| e.to_string())?
        .account_switch_mode;
    let direct = !restart && (allow_running == Some(true) || mode == AccountSwitchMode::Direct);
    let _file_guard = crate::auth::lock_auth_files()
        .await
        .map_err(|e| e.to_string())?;
    let store = load_accounts().map_err(|e| e.to_string())?;

    let target = store
        .accounts
        .iter()
        .find(|account| account.id == account_id)
        .ok_or_else(|| format!("Account not found: {account_id}"))?;
    if target.credentials_invalid {
        return Err("Account credentials invalid; sign in again".into());
    }

    if !restart && store.active_account_id.as_deref() == Some(account_id) {
        return Ok(());
    }

    // ChatGPT rotates single-use refresh tokens. Preserve the latest token
    // before replacing auth.json, otherwise switching back restores a stale one.
    let mut previous_auth = read_current_auth().map_err(|e| e.to_string())?;
    if let Some(auth) = previous_auth.as_ref() {
        update_accounts(|current| {
            sync_active_account_tokens(current, &auth);
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    }

    // Reapplying the active account must use tokens synchronized above, not the
    // pre-sync snapshot (refresh tokens can be single-use).
    let current_store = load_accounts().map_err(|e| e.to_string())?;
    let target = current_store
        .accounts
        .iter()
        .find(|a| a.id == account_id)
        .ok_or_else(|| format!("Account not found: {account_id}"))?;
    let mut account = ensure_chatgpt_tokens_fresh_locked(target)
        .await
        .map_err(|e| e.to_string())?;

    // Keep the entire close -> credential transaction -> reopen sequence serialized.
    // Refresh the target credentials first so a failed refresh never closes the app.
    let reopen_token = if !direct {
        let result = super::kill_codex_processes(Some(true), Some(true)).await?;
        if !result.failed_pids.is_empty() {
            return Err(
                "Could not close all Codex processes; account switching was cancelled".into(),
            );
        }
        ensure_codex_not_running()?;
        // Closing may flush the active session's last rotated tokens to auth.json.
        previous_auth = read_current_auth().map_err(|e| e.to_string())?;
        if let Some(auth) = previous_auth.as_ref() {
            update_accounts(|current| {
                sync_active_account_tokens(current, auth);
                Ok(())
            })
            .map_err(|e| e.to_string())?;
        }
        // Closing Codex can flush newer credentials for the same account.
        account = load_accounts()
            .map_err(|e| e.to_string())?
            .accounts
            .into_iter()
            .find(|a| a.id == account_id)
            .ok_or_else(|| format!("Account not found: {account_id}"))?;
        result.reopen_token
    } else {
        None
    };

    // Write to ~/.codex/auth.json
    switch_to_account(&account).map_err(|e| e.to_string())?;

    let committed = update_accounts(|current| {
        let target = current
            .accounts
            .iter_mut()
            .find(|a| a.id == account_id)
            .context("Account was removed during switching")?;
        target.last_used_at = Some(chrono::Utc::now());
        current.active_account_id = Some(account_id.to_owned());
        Ok(())
    });
    if let Err(error) = committed {
        let restored = (|| -> anyhow::Result<()> {
            let path = crate::auth::get_codex_auth_file()?;
            match previous_auth {
                Some(auth) => {
                    let bytes = zeroize::Zeroizing::new(serde_json::to_vec_pretty(&auth)?);
                    crate::auth::secure_file::atomic_write(&path, &bytes)
                }
                None => std::fs::remove_file(path).map_err(Into::into),
            }
        })();
        return Err(if restored.is_ok() {
            format!("Switch cancelled; previous credentials restored: {error}")
        } else {
            "Switch metadata failed and previous credentials could not be restored. Restart Codex Account Manager and explicitly select an account.".into()
        });
    }

    if let Some(token) = reopen_token {
        super::reopen_closed_codex_desktop(token)
            .await
            .map_err(|error| format!("Account switched, but reopening Codex failed: {error}"))?;
    } else if restart {
        // A restart should also start Codex when there was no running desktop
        // instance to capture and reopen.
        super::open_codex_app().await?;
    }

    Ok(())
}

/// Remove an account
#[tauri::command]
pub async fn delete_account(account_id: String) -> Result<(), String> {
    let _auth_guard = AUTH_OPERATION_LOCK.lock().await;
    let _file_guard = crate::auth::lock_auth_files()
        .await
        .map_err(|e| e.to_string())?;
    update_accounts(|store| {
        if store.active_account_id.as_deref() == Some(&account_id) {
            anyhow::bail!("Switch to another account before deleting the active account");
        }
        if !store.accounts.iter().any(|a| a.id == account_id) {
            anyhow::bail!("Account not found");
        }
        store.accounts.retain(|a| a.id != account_id);
        store.masked_account_ids.retain(|id| id != &account_id);
        Ok(())
    })
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Rename an account
#[tauri::command]
pub async fn rename_account(account_id: String, new_name: String) -> Result<(), String> {
    crate::auth::storage::update_account_metadata(&account_id, Some(new_name), None, None, None)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Get the list of masked account IDs
#[tauri::command]
pub async fn get_masked_account_ids() -> Result<Vec<String>, String> {
    crate::auth::storage::get_masked_account_ids().map_err(|e| e.to_string())
}

/// Set the list of masked account IDs
#[tauri::command]
pub async fn set_masked_account_ids(ids: Vec<String>) -> Result<(), String> {
    crate::auth::storage::set_masked_account_ids(ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_account_risk_control(
    account_id: String,
    risk_controlled: bool,
) -> Result<(), String> {
    update_accounts(|store| {
        let account = store
            .accounts
            .iter_mut()
            .find(|a| a.id == account_id)
            .ok_or_else(|| anyhow::anyhow!("Account not found"))?;
        account.risk_controlled = risk_controlled;
        account.sync_updated_at = Some(chrono::Utc::now());
        Ok(())
    })
    .map_err(|e| e.to_string())
}
