//! Restricted, durable file replacement and bounded cross-process locking.
use anyhow::{Context, Result};
use fs2::FileExt;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
    time::{Duration, Instant},
};

pub fn read_limited(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let file = File::open(path).context("Could not open data file")?;
    if !file.metadata()?.is_file() {
        anyhow::bail!("Expected a regular data file");
    }
    let mut data = Vec::new();
    file.take(limit + 1).read_to_end(&mut data)?;
    if data.len() as u64 > limit {
        anyhow::bail!("Data file exceeds the size limit");
    }
    Ok(data)
}

#[cfg(windows)]
fn windows_current_sid() -> Result<&'static str> {
    static SID: std::sync::LazyLock<std::result::Result<String, String>> =
        std::sync::LazyLock::new(|| {
            use std::os::windows::process::CommandExt;
            let system =
                std::env::var_os("SystemRoot").ok_or("Windows system directory unavailable")?;
            let result = std::process::Command::new(Path::new(&system).join("System32/whoami.exe"))
                .args(["/user", "/fo", "csv", "/nh"])
                .creation_flags(0x08000000)
                .output()
                .map_err(|_| "Could not identify file owner")?;
            if !result.status.success() {
                return Err("Could not identify file owner".into());
            }
            let text =
                String::from_utf8(result.stdout).map_err(|_| "Invalid Windows identity output")?;
            let sid = text
                .trim()
                .rsplit(',')
                .next()
                .unwrap_or("")
                .trim_matches('"');
            if !sid.starts_with("S-1-")
                || !sid
                    .chars()
                    .all(|c| c.is_ascii_digit() || c == 'S' || c == '-')
            {
                return Err("Invalid Windows owner identity".into());
            }
            Ok(sid.to_owned())
        });
    SID.as_ref()
        .map(String::as_str)
        .map_err(|error| anyhow::anyhow!(error.clone()))
}

pub fn restrict(path: &Path, directory: bool) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
        )?;
    }
    #[cfg(windows)]
    {
        let sid = windows_current_sid()?;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::{
                Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
                SetFileSecurityW, DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
            },
        };
        // Replace old explicit and inherited grants with a protected current-user DACL.
        let inheritance = if directory { "OICI" } else { "" };
        let descriptor: Vec<u16> = format!("D:P(A;{inheritance};FA;;;{sid})")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let filename: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut security = std::ptr::null_mut();
        // SAFETY: both buffers stay alive and the allocated descriptor is freed exactly once.
        unsafe {
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                descriptor.as_ptr(),
                1,
                &mut security,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(std::io::Error::last_os_error())
                    .context("Could not create private file permissions");
            }
            let result = SetFileSecurityW(
                filename.as_ptr(),
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                security,
            );
            let error = if result == 0 {
                Some(std::io::Error::last_os_error())
            } else {
                None
            };
            LocalFree(security);
            if let Some(error) = error {
                return Err(error).context("Could not restrict data file permissions");
            }
        }
    }
    Ok(())
}

pub fn atomic_write(path: &Path, data: &[u8]) -> Result<()> {
    let parent = path.parent().context("Data file has no parent directory")?;
    fs::create_dir_all(parent)?;
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        anyhow::bail!("Refusing to replace a symbolic-link data file");
    }
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    restrict(file.path(), false)?;
    file.write_all(data)?;
    file.as_file().sync_all()?;
    file.persist(path)
        .map_err(|e| e.error)
        .context("Could not atomically replace data file")?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}

pub struct FileLock(File);
impl FileLock {
    pub fn acquire(path: &Path) -> Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        restrict(path, false)?;
        let start = Instant::now();
        loop {
            match file.try_lock_exclusive() {
                Ok(()) => return Ok(Self(file)),
                Err(e)
                    if (e.kind() == std::io::ErrorKind::WouldBlock
                        || e.raw_os_error() == fs2::lock_contended_error().raw_os_error())
                        && start.elapsed() < Duration::from_secs(3) =>
                {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(e) => {
                    return Err(e)
                        .context("Account store is busy; retry after the other operation finishes")
                }
            }
        }
    }
}
impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn waits_for_another_operation_to_release_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.lock");
        let first = FileLock::acquire(&path).unwrap();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            drop(first);
        });
        let second = FileLock::acquire(&path).unwrap();
        releaser.join().unwrap();
        drop(second);
    }
    #[test]
    fn replacement_and_size_limits() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data");
        atomic_write(&path, b"old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(read_limited(&path, 3).unwrap(), b"new");
        assert!(read_limited(&path, 2).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let original = dir.path().join("original");
        fs::write(&original, b"keep").unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&original, &link).unwrap();
        assert!(atomic_write(&link, b"replace").is_err());
        assert_eq!(fs::read(original).unwrap(), b"keep");
    }
}
