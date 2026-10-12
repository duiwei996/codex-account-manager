//! Account storage module - manages reading and writing accounts.json

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};

use crate::types::{
    parse_chatgpt_id_token_claims, AccountsStore, AppSettings, AuthData, AuthDotJson, StoredAccount,
};

pub fn sync_active_account_tokens(store: &mut AccountsStore, auth: &AuthDotJson) -> bool {
    let Some(active_id) = store.active_account_id.as_deref() else {
        return false;
    };
    let Some(tokens) = auth.tokens.as_ref() else {
        return false;
    };
    let Some(account) = store
        .accounts
        .iter_mut()
        .find(|account| account.id == active_id)
    else {
        return false;
    };
    if account
        .credentials_updated_at
        .is_some_and(|saved| auth.last_refresh.is_none_or(|live| live < saved))
    {
        return false;
    }
    let AuthData::ChatGPT {
        id_token,
        access_token,
        refresh_token,
        account_id,
    } = &mut account.auth_data
    else {
        return false;
    };

    let stored_account_id = parse_chatgpt_id_token_claims(id_token)
        .account_id
        .or_else(|| account_id.clone());
    let current_account_id = parse_chatgpt_id_token_claims(&tokens.id_token)
        .account_id
        .or_else(|| tokens.account_id.clone());
    let (Some(stored_account_id), Some(current_account_id)) =
        (stored_account_id, current_account_id)
    else {
        return false;
    };
    if stored_account_id != current_account_id {
        return false;
    }

    let changed = *id_token != tokens.id_token
        || *access_token != tokens.access_token
        || *refresh_token != tokens.refresh_token
        || account_id.as_ref() != Some(&current_account_id);
    if !changed {
        return false;
    }

    id_token.clone_from(&tokens.id_token);
    access_token.clone_from(&tokens.access_token);
    refresh_token.clone_from(&tokens.refresh_token);
    *account_id = Some(current_account_id);
    account.credentials_updated_at = auth.last_refresh;
    true
}

/// Get the path to the codex-switcher config directory
pub fn get_config_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().context("Could not find home directory")?;
    // Project-local account metadata and tokens.
    Ok(home.join(".codex-switcher-cn"))
}

/// Get the path to accounts.json
pub fn get_accounts_file() -> Result<PathBuf> {
    Ok(get_config_dir()?.join("accounts.json"))
}

pub fn get_settings_file() -> Result<PathBuf> {
    Ok(get_config_dir()?.join("settings.json"))
}

const MAX_STORE_BYTES: u64 = 8 * 1024 * 1024;

fn with_store_lock<T>(operation: impl FnOnce() -> Result<T>) -> Result<T> {
    let dir = get_config_dir()?;
    fs::create_dir_all(&dir)?;
    super::secure_file::restrict(&dir, true)?;
    let _lock = super::secure_file::FileLock::acquire(&dir.join("store.lock"))?;
    operation()
}

fn load_accounts_unlocked() -> Result<AccountsStore> {
    let path = get_accounts_file()?;
    if !path.exists() {
        return Ok(AccountsStore::default());
    }
    let raw = zeroize::Zeroizing::new(super::secure_file::read_limited(&path, MAX_STORE_BYTES)?);
    let value: serde_json::Value =
        serde_json::from_slice(&raw).context("Invalid account data file")?;
    let encrypted = value.get("vault_version").is_some();
    drop(value);
    let plaintext = if encrypted {
        super::vault::decode(&raw)?
    } else {
        raw
    };
    let mut store: AccountsStore =
        serde_json::from_slice(&plaintext).context("Invalid account store")?;
    let renamed = normalize_generated_names(&mut store);
    super::validation::validate_store(&store)?;
    if !encrypted || renamed {
        save_accounts_unlocked(&store)?;
    }
    Ok(store)
}

fn save_accounts_unlocked(store: &AccountsStore) -> Result<()> {
    super::validation::validate_store(store)?;
    let path = get_accounts_file()?;
    let existing_encrypted = if path.exists() {
        let bytes =
            zeroize::Zeroizing::new(super::secure_file::read_limited(&path, MAX_STORE_BYTES)?);
        serde_json::from_slice::<serde_json::Value>(&bytes)?
            .get("vault_version")
            .is_some()
    } else {
        false
    };
    let plaintext = zeroize::Zeroizing::new(serde_json::to_vec(store)?);
    let encrypted = super::vault::encode(&plaintext, !existing_encrypted)?;
    if encrypted.len() as u64 > MAX_STORE_BYTES {
        anyhow::bail!("Encrypted account store exceeds the 8 MiB limit");
    }
    super::secure_file::atomic_write(&path, &encrypted)
}

pub fn prepare_account_store() -> Result<()> {
    with_store_lock(|| save_accounts_unlocked(&load_accounts_unlocked()?))
}

pub fn load_accounts() -> Result<AccountsStore> {
    with_store_lock(load_accounts_unlocked)
}

pub fn update_accounts<T>(operation: impl FnOnce(&mut AccountsStore) -> Result<T>) -> Result<T> {
    with_store_lock(|| {
        let mut store = load_accounts_unlocked()?;
        let before = zeroize::Zeroizing::new(serde_json::to_vec(&store)?);
        let result = operation(&mut store)?;
        let after = zeroize::Zeroizing::new(serde_json::to_vec(&store)?);
        if after.as_slice() != before.as_slice() {
            save_accounts_unlocked(&store)?;
        }
        Ok(result)
    })
}

pub fn load_app_settings() -> Result<AppSettings> {
    with_store_lock(|| {
        let path = get_settings_file()?;
        if !path.exists() {
            return Ok(AppSettings::default());
        }
        serde_json::from_slice(&super::secure_file::read_limited(&path, 64 * 1024)?)
            .context("Invalid app settings")
    })
}

pub fn update_app_settings<T>(operation: impl FnOnce(&mut AppSettings) -> Result<T>) -> Result<T> {
    with_store_lock(|| {
        let path = get_settings_file()?;
        let mut settings = if path.exists() {
            serde_json::from_slice(&super::secure_file::read_limited(&path, 64 * 1024)?)?
        } else {
            AppSettings::default()
        };
        let result = operation(&mut settings)?;
        super::secure_file::atomic_write(&path, &serde_json::to_vec_pretty(&settings)?)?;
        Ok(result)
    })
}

/// Email plus plan identifies a login entry; never merge different plans.
pub(crate) fn same_account_type(a: &StoredAccount, b: &StoredAccount) -> bool {
    match (&a.auth_data, &b.auth_data) {
        (AuthData::ApiKey { key: a }, AuthData::ApiKey { key: b }) => a == b,
        (
            AuthData::ChatGPT {
                account_id: aid,
                id_token: at,
                ..
            },
            AuthData::ChatGPT {
                account_id: bid,
                id_token: bt,
                ..
            },
        ) => {
            let plan = |account: &StoredAccount| {
                account
                    .plan_type
                    .as_deref()
                    .unwrap_or("")
                    .trim()
                    .to_lowercase()
            };
            if plan(a) != plan(b) {
                return false;
            }
            match (
                a.email.as_deref().filter(|email| !email.trim().is_empty()),
                b.email.as_deref().filter(|email| !email.trim().is_empty()),
            ) {
                (Some(a), Some(b)) => a.trim().eq_ignore_ascii_case(b.trim()),
                (None, None) => match (
                    aid.as_deref().filter(|id| !id.is_empty()),
                    bid.as_deref().filter(|id| !id.is_empty()),
                ) {
                    (Some(a), Some(b)) => a == b,
                    _ => at == bt,
                },
                _ => false,
            }
        }
        _ => false,
    }
}

pub(crate) fn display_name_type(account: &StoredAccount) -> String {
    match &account.auth_data {
        AuthData::ApiKey { .. } => "api_key".into(),
        AuthData::ChatGPT { .. } => account
            .plan_type
            .as_deref()
            .unwrap_or("unknown")
            .trim()
            .to_lowercase(),
    }
}

fn unique_display_name(store: &AccountsStore, account: &StoredAccount, name: &str) -> String {
    let mut candidate = name.to_owned();
    let base: String = name.chars().take(110).collect();
    let mut suffix = 2;
    while store.accounts.iter().any(|other| {
        other.id != account.id
            && other.name.trim() == candidate.trim()
            && display_name_type(other) == display_name_type(account)
    }) {
        candidate = format!("{base} #{suffix}");
        suffix += 1;
    }
    candidate
}

// Only repair old automatically generated email suffixes, preserving custom names.
fn normalize_generated_names(store: &mut AccountsStore) -> bool {
    let mut changed = false;
    for index in 0..store.accounts.len() {
        let account = &store.accounts[index];
        let Some(email) = account.email.as_deref() else {
            continue;
        };
        let generated = account
            .name
            .strip_prefix(&format!("{email} #"))
            .is_some_and(|suffix| suffix.parse::<u32>().is_ok_and(|n| n >= 2));
        if generated {
            let name = unique_display_name(store, account, email);
            if name != account.name {
                store.accounts[index].name = name;
                changed = true;
            }
        }
    }
    changed
}

pub(crate) fn upsert_account(
    store: &mut AccountsStore,
    mut account: StoredAccount,
) -> Result<StoredAccount> {
    super::validation::validate_account(&account)?;
    let existing = store
        .accounts
        .iter()
        .find(|existing| {
            same_account_type(existing, &account)
                && store.active_account_id.as_deref() == Some(&existing.id)
        })
        .or_else(|| {
            store
                .accounts
                .iter()
                .find(|existing| same_account_type(existing, &account))
        })
        .cloned();
    if let Some(existing) = existing {
        account.id = existing.id.clone();
        account.name = existing.name;
        account.created_at = existing.created_at;
        account.last_used_at = existing.last_used_at;
        account.subscription_expires_at = account
            .subscription_expires_at
            .or(existing.subscription_expires_at);
        account.credentials_updated_at = account.credentials_updated_at.or(Some(Utc::now()));
        store
            .accounts
            .retain(|entry| entry.id == account.id || !same_account_type(entry, &account));
        *store
            .accounts
            .iter_mut()
            .find(|entry| entry.id == account.id)
            .unwrap() = account.clone();
        store
            .masked_account_ids
            .retain(|id| store.accounts.iter().any(|entry| &entry.id == id));
    } else {
        account.name = unique_display_name(store, &account, &account.name);
        store.accounts.push(account.clone());
    }
    super::validation::validate_store(store)?;
    Ok(account)
}

/// Add or replace an account using the same identity rules as batch import.
pub fn add_account(account: StoredAccount) -> Result<StoredAccount> {
    update_accounts(|store| upsert_account(store, account))
}

#[cfg(test)]
mod account_merge_tests {
    use super::*;
    #[test]
    fn suffixes_only_disambiguate_names_with_the_same_type() {
        let mut store = AccountsStore::default();
        let first = upsert_account(&mut store, login("team", "one")).unwrap();
        let mut second = login("TEAM", "two");
        second.email = Some("different@example.com".into());
        second.name = first.name.clone();
        let second = upsert_account(&mut store, second).unwrap();
        assert_eq!(second.name, format!("{} #2", first.name));
        let mut plus = login("plus", "three");
        plus.name = first.name.clone();
        assert_eq!(upsert_account(&mut store, plus).unwrap().name, first.name);
        super::super::validation::validate_store(&store).unwrap();
    }

    #[test]
    fn old_email_suffixes_are_repaired_without_touching_custom_names() {
        let free = login("free", "free");
        let mut team = login("team", "team");
        let mut custom = login("plus", "plus");
        team.name = format!("{} #2", free.name);
        custom.name = "My account #2".into();
        let mut store = AccountsStore::default();
        store.accounts = vec![free.clone(), team, custom];
        assert!(normalize_generated_names(&mut store));
        assert_eq!(store.accounts[1].name, free.name);
        assert_eq!(store.accounts[2].name, "My account #2");
        assert!(!normalize_generated_names(&mut store));
        let mut duplicate = login("free", "duplicate");
        duplicate.name = "same@example.com #2".into();
        store.accounts.push(duplicate);
        assert!(!normalize_generated_names(&mut store));
    }
    fn login(plan: &str, token: &str) -> StoredAccount {
        StoredAccount::new_chatgpt(
            String::new(),
            Some("same@example.com".into()),
            Some(plan.into()),
            None,
            "synthetic-id".into(),
            "synthetic-access".into(),
            token.into(),
            Some("workspace".into()),
        )
    }
    #[test]
    fn same_email_different_plans_survive_and_matching_plan_replaces_credentials() {
        let mut store = AccountsStore::default();
        let plus = upsert_account(&mut store, login("plus", "old-plus")).unwrap();
        let team = upsert_account(&mut store, login("team", "old-team")).unwrap();
        assert_ne!(plus.id, team.id);
        assert_eq!(plus.name, team.name);
        assert_eq!(store.accounts.len(), 2);
        store.active_account_id = Some(team.id.clone());
        store.masked_account_ids = vec![team.id.clone()];
        let mut incoming = login(" TEAM ", "new-team");
        incoming.email = Some("SAME@EXAMPLE.COM".into());
        let replaced = upsert_account(&mut store, incoming).unwrap();
        assert_eq!(store.accounts.len(), 2);
        assert_eq!(replaced.id, team.id);
        assert_eq!(replaced.created_at, team.created_at);
        assert_eq!(replaced.name, team.name);
        assert_eq!(store.active_account_id.as_deref(), Some(team.id.as_str()));
        assert_eq!(store.masked_account_ids, vec![team.id]);
        match replaced.auth_data {
            AuthData::ChatGPT { refresh_token, .. } => assert_eq!(refresh_token, "new-team"),
            _ => panic!("login credentials expected"),
        }
        assert!(store.accounts.iter().any(|account| account.id == plus.id));
    }
    #[test]
    fn missing_identity_never_collapses_unrelated_accounts_and_duplicate_keys_reuse_entry() {
        let mut a = login("team", "a");
        let mut b = login("team", "b");
        a.email = None;
        assert!(!same_account_type(&a, &b));
        b.email = None;
        assert!(same_account_type(&a, &b));
        b.plan_type = Some("plus".into());
        assert!(!same_account_type(&a, &b));
        let mut store = AccountsStore::default();
        let first = upsert_account(
            &mut store,
            StoredAccount::new_api_key("api".into(), "synthetic-key".into()),
        )
        .unwrap();
        let next = upsert_account(
            &mut store,
            StoredAccount::new_api_key("api".into(), "synthetic-key".into()),
        )
        .unwrap();
        assert_eq!(first.id, next.id);
        assert_eq!(store.accounts.len(), 1);
    }
}

/// Remove an account by ID
pub fn remove_account(account_id: &str) -> Result<()> {
    update_accounts(|store| {
        let initial_len = store.accounts.len();
        store.accounts.retain(|a| a.id != account_id);

        if store.accounts.len() == initial_len {
            anyhow::bail!("Account not found: {account_id}");
        }

        // If we removed the active account, clear it or set to first available
        if store.active_account_id.as_deref() == Some(account_id) {
            store.active_account_id = None;
        }

        store.masked_account_ids.retain(|id| id != account_id);
        Ok(())
    })
}

/// Update the active account ID
pub fn set_active_account(account_id: &str) -> Result<()> {
    update_accounts(|store| {
        // Verify the account exists
        if !store.accounts.iter().any(|a| a.id == account_id) {
            anyhow::bail!("Account not found: {account_id}");
        }

        store.active_account_id = Some(account_id.to_string());

        Ok(())
    })
}

/// Get an account by ID
pub fn get_account(account_id: &str) -> Result<Option<StoredAccount>> {
    let store = load_accounts()?;
    Ok(store.accounts.into_iter().find(|a| a.id == account_id))
}

/// Get the currently active account
pub fn get_active_account() -> Result<Option<StoredAccount>> {
    let store = load_accounts()?;
    let active_id = match &store.active_account_id {
        Some(id) => id,
        None => return Ok(None),
    };
    Ok(store.accounts.into_iter().find(|a| a.id == *active_id))
}

/// Update an account's last_used_at timestamp
pub fn touch_account(account_id: &str) -> Result<()> {
    update_accounts(|store| {
        if let Some(account) = store.accounts.iter_mut().find(|a| a.id == account_id) {
            account.last_used_at = Some(chrono::Utc::now());
        }

        Ok(())
    })
}

/// Update an account's metadata (name, email, plan_type, subscription expiry)
pub fn update_account_metadata(
    account_id: &str,
    name: Option<String>,
    email: Option<String>,
    plan_type: Option<String>,
    subscription_expires_at: Option<Option<DateTime<Utc>>>,
) -> Result<StoredAccount> {
    update_accounts(|store| {
        if let Some(ref new_name) = name {
            super::validation::validate_name(new_name)?;
        }
        let target = store
            .accounts
            .iter()
            .find(|a| a.id == account_id)
            .context("Account not found")?;
        let mut updated = target.clone();
        if let Some(ref plan) = plan_type {
            updated.plan_type = Some(plan.clone());
        }
        let updated_name =
            unique_display_name(store, &updated, name.as_deref().unwrap_or(&target.name));

        // Now find and update the account
        let account = store
            .accounts
            .iter_mut()
            .find(|a| a.id == account_id)
            .context("Account not found")?;

        account.name = updated_name;

        if let Some(new_email) = email {
            if account.email.as_ref() != Some(&new_email) {
                account.email = Some(new_email);
            }
        }

        if let Some(new_plan_type) = plan_type {
            if account.plan_type.as_ref() != Some(&new_plan_type) {
                account.plan_type = Some(new_plan_type);
            }
        }

        if let Some(subscription_expires_at) = subscription_expires_at {
            if account.subscription_expires_at != subscription_expires_at {
                account.subscription_expires_at = subscription_expires_at;
            }
        }

        let updated = account.clone();
        Ok(updated)
    })
}

/// Update ChatGPT OAuth tokens for an account and return the updated account.
pub fn update_account_chatgpt_tokens(
    account_id: &str,
    id_token: String,
    access_token: String,
    refresh_token: String,
    chatgpt_account_id: Option<String>,
    email: Option<String>,
    plan_type: Option<String>,
    subscription_expires_at: Option<DateTime<Utc>>,
) -> Result<StoredAccount> {
    update_accounts(|store| {
        let account = store
            .accounts
            .iter_mut()
            .find(|a| a.id == account_id)
            .context("Account not found")?;

        match &mut account.auth_data {
            AuthData::ChatGPT {
                id_token: stored_id_token,
                access_token: stored_access_token,
                refresh_token: stored_refresh_token,
                account_id: stored_account_id,
            } => {
                *stored_id_token = id_token;
                *stored_access_token = access_token;
                *stored_refresh_token = refresh_token;
                if let Some(new_account_id) = chatgpt_account_id {
                    *stored_account_id = Some(new_account_id);
                }
            }
            AuthData::ApiKey { .. } => {
                anyhow::bail!("Cannot update OAuth tokens for an API key account");
            }
        }

        if let Some(new_email) = email {
            account.email = Some(new_email);
        }

        if let Some(new_plan_type) = plan_type {
            account.plan_type = Some(new_plan_type);
        }

        if let Some(subscription_expires_at) = subscription_expires_at {
            account.subscription_expires_at = Some(subscription_expires_at);
        }

        account.credentials_updated_at = Some(chrono::Utc::now());
        let updated = account.clone();

        Ok(updated)
    })
}

/// Get the list of masked account IDs
pub fn get_masked_account_ids() -> Result<Vec<String>> {
    let store = load_accounts()?;
    Ok(store.masked_account_ids.clone())
}

/// Set the list of masked account IDs
pub fn set_masked_account_ids(ids: Vec<String>) -> Result<()> {
    update_accounts(|store| {
        store.masked_account_ids = ids
            .into_iter()
            .filter(|id| store.accounts.iter().any(|a| &a.id == id))
            .collect();
        store.masked_account_ids.sort();
        store.masked_account_ids.dedup();

        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::sync_active_account_tokens;
    use crate::types::{AccountsStore, AuthData, AuthDotJson, StoredAccount, TokenData};
    use base64::Engine;

    fn account(name: &str, account_id: &str, suffix: &str) -> StoredAccount {
        StoredAccount::new_chatgpt(
            name.into(),
            None,
            None,
            None,
            format!("id-{suffix}"),
            format!("access-{suffix}"),
            format!("refresh-{suffix}"),
            Some(account_id.into()),
        )
    }

    fn auth(account_id: &str, suffix: &str) -> AuthDotJson {
        AuthDotJson {
            openai_api_key: None,
            tokens: Some(TokenData {
                id_token: format!("id-{suffix}"),
                access_token: format!("access-{suffix}"),
                refresh_token: format!("refresh-{suffix}"),
                account_id: Some(account_id.into()),
            }),
            last_refresh: None,
        }
    }

    fn refresh_token(account: &StoredAccount) -> &str {
        match &account.auth_data {
            AuthData::ChatGPT { refresh_token, .. } => refresh_token,
            AuthData::ApiKey { .. } => panic!("expected ChatGPT account"),
        }
    }

    fn id_token_with_account_id(account_id: &str, suffix: &str) -> String {
        let payload =
            format!(r#"{{"https://api.openai.com/auth":{{"chatgpt_account_id":"{account_id}"}}}}"#);
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
        format!("header.{encoded}.{suffix}")
    }

    #[test]
    fn older_live_auth_cannot_overwrite_a_newly_saved_refresh_token() {
        let mut account = account("A", "workspace-a", "new");
        account.credentials_updated_at = Some(chrono::Utc::now());
        let mut store = AccountsStore {
            active_account_id: Some(account.id.clone()),
            accounts: vec![account],
            ..AccountsStore::default()
        };
        let mut stale = auth("workspace-a", "old");
        stale.last_refresh = Some(chrono::Utc::now() - chrono::Duration::hours(1));
        assert!(!sync_active_account_tokens(&mut store, &stale));
        assert_eq!(refresh_token(&store.accounts[0]), "refresh-new");
    }

    #[test]
    fn preserves_rotated_tokens_before_switching_away_and_back() {
        let account_a = account("A", "workspace-a", "a1");
        let account_a_id = account_a.id.clone();
        let account_b = account("B", "workspace-b", "b1");
        let account_b_id = account_b.id.clone();
        let mut store = AccountsStore {
            accounts: vec![account_a, account_b],
            active_account_id: Some(account_a_id.clone()),
            ..AccountsStore::default()
        };

        assert!(!sync_active_account_tokens(
            &mut store,
            &auth("workspace-b", "wrong-account")
        ));
        assert_eq!(refresh_token(&store.accounts[0]), "refresh-a1");

        let mut auth_without_top_level_id = auth("workspace-b", "missing-id");
        let tokens = auth_without_top_level_id.tokens.as_mut().unwrap();
        tokens.id_token = id_token_with_account_id("workspace-b", "signature");
        tokens.account_id = None;
        assert!(!sync_active_account_tokens(
            &mut store,
            &auth_without_top_level_id
        ));
        assert_eq!(refresh_token(&store.accounts[0]), "refresh-a1");

        let mut auth_without_identity = auth("workspace-a", "unknown");
        auth_without_identity.tokens.as_mut().unwrap().account_id = None;
        assert!(!sync_active_account_tokens(
            &mut store,
            &auth_without_identity
        ));
        assert_eq!(refresh_token(&store.accounts[0]), "refresh-a1");

        assert!(sync_active_account_tokens(
            &mut store,
            &auth("workspace-a", "a2")
        ));
        store.active_account_id = Some(account_b_id);

        let restored_a = store
            .accounts
            .iter()
            .find(|account| account.id == account_a_id)
            .unwrap();
        let AuthData::ChatGPT { refresh_token, .. } = &restored_a.auth_data else {
            panic!("expected ChatGPT account");
        };
        assert_eq!(refresh_token, "refresh-a2");
    }

    #[test]
    fn rejects_live_tokens_when_stored_account_identity_is_unknown() {
        let mut account = account("A", "workspace-a", "a1");
        let account_id = account.id.clone();
        let AuthData::ChatGPT {
            id_token,
            account_id: chatgpt_account_id,
            ..
        } = &mut account.auth_data
        else {
            panic!("expected ChatGPT account");
        };
        *id_token = "opaque-id-token".into();
        *chatgpt_account_id = None;

        let mut store = AccountsStore {
            accounts: vec![account],
            active_account_id: Some(account_id),
            ..AccountsStore::default()
        };

        assert!(!sync_active_account_tokens(
            &mut store,
            &auth("workspace-a", "a2")
        ));
        assert_eq!(refresh_token(&store.accounts[0]), "refresh-a1");
    }

    #[test]
    fn derives_stored_identity_from_id_token_and_backfills_account_id() {
        let mut account = account("A", "workspace-a", "a1");
        let account_id = account.id.clone();
        let AuthData::ChatGPT {
            id_token,
            account_id: chatgpt_account_id,
            ..
        } = &mut account.auth_data
        else {
            panic!("expected ChatGPT account");
        };
        *id_token = id_token_with_account_id("workspace-a", "stored");
        *chatgpt_account_id = None;

        let mut store = AccountsStore {
            accounts: vec![account],
            active_account_id: Some(account_id),
            ..AccountsStore::default()
        };

        assert!(sync_active_account_tokens(
            &mut store,
            &auth("workspace-a", "a2")
        ));
        let AuthData::ChatGPT { account_id, .. } = &store.accounts[0].auth_data else {
            panic!("expected ChatGPT account");
        };
        assert_eq!(account_id.as_deref(), Some("workspace-a"));
        assert_eq!(refresh_token(&store.accounts[0]), "refresh-a2");
    }
}
