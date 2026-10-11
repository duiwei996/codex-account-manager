//! Authentication module

pub mod oauth_server;
pub mod secure_file;
pub mod storage;
pub mod switcher;
pub mod token_refresh;
pub mod validation;
mod vault;

// ponytail: refreshes are rare; one global lock keeps auth.json and accounts.json ordered.
pub(crate) static AUTH_OPERATION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub async fn lock_auth_files() -> anyhow::Result<secure_file::FileLock> {
    tokio::task::spawn_blocking(|| {
        let dir = storage::get_config_dir()?;
        std::fs::create_dir_all(&dir)?;
        secure_file::restrict(&dir, true)?;
        secure_file::FileLock::acquire(&dir.join("auth-operation.lock"))
    })
    .await?
}

pub use oauth_server::*;
pub use storage::*;
pub use switcher::*;
pub use token_refresh::*;
