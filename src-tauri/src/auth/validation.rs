use crate::types::{AccountsStore, AuthData, AuthMode, StoredAccount};
use anyhow::Result;
use std::collections::HashSet;
pub const MAX_ACCOUNTS: usize = 200;
pub const MAX_CREDENTIAL_BYTES: usize = 64 * 1024;
pub fn validate_name(name: &str) -> Result<()> {
    if name.trim().is_empty() || name.chars().count() > 120 || name.chars().any(char::is_control) {
        anyhow::bail!("Account name must contain 1–120 characters and no control characters");
    }
    Ok(())
}
/// Login may defer the display name until the authenticated email is known.
pub fn validate_optional_name(name: &str) -> Result<()> {
    if name.trim().is_empty() && !name.chars().any(char::is_control) {
        return Ok(());
    }
    validate_name(name)
}
pub fn validate_account(account: &StoredAccount) -> Result<()> {
    validate_name(&account.name)?;
    if uuid::Uuid::parse_str(&account.id).is_err() {
        anyhow::bail!("Invalid account identifier");
    }
    let valid = |value: &str| {
        !value.trim().is_empty()
            && value.len() <= MAX_CREDENTIAL_BYTES
            && !value.chars().any(char::is_control)
    };
    match (&account.auth_mode, &account.auth_data) {
        (AuthMode::ApiKey, AuthData::ApiKey { key }) if valid(key) => (),
        (AuthMode::ChatGPT, AuthData::ChatGPT { id_token, access_token, refresh_token, .. })
            if valid(id_token) && valid(access_token) && valid(refresh_token) => (),
        _ => anyhow::bail!("Account credentials are empty, oversized or inconsistent with their authentication mode"),
    }
    Ok(())
}
pub fn validate_store(store: &AccountsStore) -> Result<()> {
    if store.version != 1 {
        anyhow::bail!("Unsupported account data version");
    }
    if store.accounts.len() > MAX_ACCOUNTS {
        anyhow::bail!("Account limit exceeded (200)");
    }
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for account in &store.accounts {
        validate_account(account)?;
        if !ids.insert(&account.id) || !names.insert(account.name.trim()) {
            anyhow::bail!("Duplicate account identifier or name");
        }
    }
    if store
        .active_account_id
        .as_ref()
        .is_some_and(|id| !ids.contains(id))
    {
        anyhow::bail!("Active account is missing");
    }
    if store.masked_account_ids.iter().any(|id| !ids.contains(id)) {
        anyhow::bail!("Masked account is missing");
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn optional_login_names_preserve_required_stored_name_validation() {
        assert!(validate_optional_name("").is_ok());
        assert!(validate_optional_name("   ").is_ok());
        assert!(validate_optional_name("自定义账号").is_ok());
        assert!(validate_optional_name(&"账".repeat(120)).is_ok());
        assert!(validate_optional_name(&"账".repeat(121)).is_err());
        assert!(validate_optional_name("\n").is_err());
        assert!(validate_optional_name("name\0").is_err());
        assert!(validate_name("").is_err());
    }
    #[test]
    fn rejects_invalid_modes_versions_and_names() {
        let mut account = StoredAccount::new_api_key("Test".into(), "secret".into());
        assert!(validate_account(&account).is_ok());
        account.auth_mode = AuthMode::ChatGPT;
        assert!(validate_account(&account).is_err());
        assert!(validate_name("\n").is_err());
        let mut store = AccountsStore::default();
        store.version = 2;
        assert!(validate_store(&store).is_err());
    }
}
