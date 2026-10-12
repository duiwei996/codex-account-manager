//! Reopen only desktop apps observed immediately before a force close.
//! Launch targets stay in the backend; the frontend receives a one-use token.

use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
enum DesktopTarget {
    #[cfg(any(target_os = "macos", test))]
    MacBundle(String),
    #[cfg(any(windows, test))]
    WindowsExecutable(String),
    #[cfg(any(windows, test))]
    WindowsIsolatedExecutable { path: String, user_data_dir: String },
    #[cfg(any(windows, test))]
    WindowsAppId(String),
}

pub(super) struct CapturedDesktop {
    pid: u32,
    target: DesktopTarget,
}

struct ReopenTicket {
    token: String,
    created_at: Instant,
    targets: Vec<DesktopTarget>,
}

static PENDING_REOPEN: Mutex<Option<ReopenTicket>> = Mutex::new(None);

#[cfg(target_os = "macos")]
pub(super) fn desktop_pids(desktops: &[CapturedDesktop]) -> Vec<u32> {
    desktops.iter().map(|desktop| desktop.pid).collect()
}

#[derive(serde::Serialize)]
pub struct CodexReopenInfo {
    supported: bool,
    desktop_count: usize,
}

#[tauri::command]
pub async fn get_codex_reopen_info() -> Result<CodexReopenInfo, String> {
    tokio::task::spawn_blocking(|| {
        let (pids, _) = super::find_codex_processes().map_err(|e| e.to_string())?;
        let desktops = capture_desktops(&pids)?;
        Ok(CodexReopenInfo {
            supported: cfg!(any(target_os = "macos", windows)),
            desktop_count: desktops.len(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

pub(super) fn capture_desktops(pids: &[u32]) -> Result<Vec<CapturedDesktop>, String> {
    let mut desktops = Vec::new();

    #[cfg(target_os = "macos")]
    {
        let names = super::read_unix_process_names();
        for &pid in pids {
            let output = super::Command::new("ps")
                .args(["-p", &pid.to_string(), "-o", "command="])
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                continue;
            }
            let command = String::from_utf8_lossy(&output.stdout);
            let name = names.get(&pid).map(String::as_str);
            if let Some(bundle) = mac_bundle_path(command.trim(), name) {
                if is_codex_bundle(&bundle) {
                    desktops.push(CapturedDesktop {
                        pid,
                        target: DesktopTarget::MacBundle(bundle),
                    });
                }
            }
        }
    }

    #[cfg(windows)]
    {
        for process in super::read_windows_codex_processes().map_err(|e| e.to_string())? {
            if !pids.contains(&process.process_id) {
                continue;
            }
            if let Some(path) = windows_desktop_executable(&process) {
                let target = if let Some(user_data_dir) =
                    windows_isolated_user_data_dir(&process.command_line)
                {
                    let executable = std::path::Path::new(&path);
                    (executable.is_file() && super::looks_like_windows_desktop_app(executable))
                        .then_some(DesktopTarget::WindowsIsolatedExecutable {
                            path,
                            user_data_dir,
                        })
                } else if path.to_ascii_lowercase().contains("\\windowsapps\\") {
                    // Packaged apps require their exact registered identity, not
                    // whichever Codex happens to be first in the Start menu.
                    Some(DesktopTarget::WindowsAppId(windows_app_id(&path).ok_or_else(|| {
                        "Could not resolve the running Codex desktop identity; closing was cancelled".to_string()
                    })?))
                } else {
                    let executable = std::path::Path::new(&path);
                    let has_desktop_resources = super::looks_like_windows_desktop_app(executable);
                    (executable.is_file() && has_desktop_resources)
                        .then_some(DesktopTarget::WindowsExecutable(path))
                };
                if let Some(target) = target {
                    desktops.push(CapturedDesktop {
                        pid: process.process_id,
                        target,
                    });
                }
            }
        }
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = (pids, &mut desktops);
    Ok(desktops)
}

#[cfg(any(target_os = "macos", test))]
fn mac_bundle_path(command: &str, name: Option<&str>) -> Option<String> {
    let suffix = match name? {
        "ChatGPT" => "/ChatGPT.app/Contents/MacOS/ChatGPT",
        "Codex" => "/Codex.app/Contents/MacOS/Codex",
        _ => return None,
    };
    if !command.starts_with('/') {
        return None;
    }
    let index = command.find(suffix)?;
    if command[index + suffix.len()..]
        .chars()
        .next()
        .is_some_and(|c| !c.is_whitespace())
    {
        return None;
    }
    Some(command[..index + suffix.find("/Contents/")?].to_string())
}

#[cfg(target_os = "macos")]
fn is_codex_bundle(bundle: &str) -> bool {
    plist::Value::from_file(std::path::Path::new(bundle).join("Contents/Info.plist"))
        .ok()
        .and_then(|value| {
            value
                .as_dictionary()?
                .get("CFBundleIdentifier")?
                .as_string()
                .map(str::to_owned)
        })
        .is_some_and(|id| id == "com.openai.codex")
}

#[cfg(any(windows, test))]
fn windows_desktop_executable(process: &super::WindowsCodexProcess) -> Option<String> {
    if !super::is_windows_codex_root_process(process)
        || super::is_ide_plugin_process(&process.command_line.to_ascii_lowercase())
    {
        return None;
    }
    let path = if process.executable_path.trim().is_empty() {
        super::windows_command_executable_path(&process.command_line)?
    } else {
        process.executable_path.trim()
    };
    let path = path.replace('/', "\\");
    let bytes = path.as_bytes();
    // Only an absolute local executable path; never a CLI name or arguments.
    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || &bytes[1..3] != b":\\" {
        return None;
    }
    Some(path)
}

#[cfg(windows)]
fn windows_isolated_user_data_dir(command: &str) -> Option<String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{Foundation::LocalFree, UI::Shell::CommandLineToArgvW};
    let wide: Vec<u16> = command.encode_utf16().chain(Some(0)).collect();
    let mut count = 0;
    let argv = unsafe { CommandLineToArgvW(wide.as_ptr(), &mut count) };
    if argv.is_null() {
        return None;
    }
    let mut args = Vec::new();
    for index in 0..count as usize {
        let value = unsafe { *argv.add(index) };
        let mut len = 0;
        while unsafe { *value.add(len) } != 0 {
            len += 1;
        }
        args.push(
            std::ffi::OsString::from_wide(unsafe { std::slice::from_raw_parts(value, len) })
                .to_string_lossy()
                .into_owned(),
        );
    }
    unsafe {
        LocalFree(argv.cast());
    }
    let value = args.iter().enumerate().find_map(|(index, arg)| {
        arg.strip_prefix("--user-data-dir=")
            .map(str::to_owned)
            .or_else(|| {
                (arg == "--user-data-dir")
                    .then(|| args.get(index + 1).cloned())
                    .flatten()
            })
    })?;
    std::path::Path::new(&value).is_absolute().then_some(value)
}

#[cfg(windows)]
fn windows_app_id(executable: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    // Resolve the manifest application whose executable matches this process.
    // Passing the path via the environment avoids interpreting it as PowerShell.
    let script = r#"
$ErrorActionPreference = 'Stop'
$exe = $env:CODEX_SWITCHER_REOPEN_EXE
foreach ($pkg in (Get-AppxPackage -Name 'OpenAI.Codex*')) {
  if (-not $pkg.InstallLocation) { continue }
  foreach ($app in (Get-AppxPackageManifest -Package $pkg.PackageFullName).Package.Applications.Application) {
    if (-not $app.Executable -or -not $app.Id) { continue }
    $candidate = Join-Path $pkg.InstallLocation $app.Executable
    if ([string]::Equals($candidate, $exe, [StringComparison]::OrdinalIgnoreCase)) {
      Write-Output ($pkg.PackageFamilyName + '!' + $app.Id)
      exit 0
    }
  }
}
exit 1
"#;
    let output = super::Command::new("powershell.exe")
        .creation_flags(super::CREATE_NO_WINDOW)
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("CODEX_SWITCHER_REOPEN_EXE", executable)
        .output()
        .ok()?;
    let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (output.status.success() && valid_windows_app_id(&id)).then_some(id)
}

#[cfg(any(windows, test))]
fn valid_windows_app_id(id: &str) -> bool {
    id.to_ascii_lowercase().starts_with("openai.codex")
        && id.contains("_2p2nqsd0c76g0!")
        && id.split('!').count() == 2
        && !id.ends_with('!')
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-!".contains(c))
}

fn closed_targets(desktops: Vec<CapturedDesktop>, killed_pids: &[u32]) -> Vec<DesktopTarget> {
    let mut targets = Vec::new();
    for desktop in desktops {
        if killed_pids.contains(&desktop.pid) && !targets.contains(&desktop.target) {
            targets.push(desktop.target);
        }
    }
    targets
}

pub(super) fn remember_closed_desktops(
    desktops: Vec<CapturedDesktop>,
    killed_pids: &[u32],
) -> Option<String> {
    let targets = closed_targets(desktops, killed_pids);
    let mut pending = PENDING_REOPEN.lock().ok()?;
    *pending = None;
    if targets.is_empty() {
        return None;
    }
    let token = uuid::Uuid::new_v4().to_string();
    *pending = Some(ReopenTicket {
        token: token.clone(),
        created_at: Instant::now(),
        targets,
    });
    Some(token)
}

fn take_targets(
    pending: &mut Option<ReopenTicket>,
    token: &str,
) -> Result<Vec<DesktopTarget>, String> {
    let valid = pending.as_ref().is_some_and(|ticket| {
        ticket.token == token && ticket.created_at.elapsed() < Duration::from_secs(120)
    });
    if !valid {
        return Err("The desktop reopen request expired or is no longer available".into());
    }
    Ok(pending.take().expect("validated ticket").targets)
}

#[tauri::command]
pub async fn reopen_closed_codex_desktop(token: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let targets = take_targets(
            &mut *PENDING_REOPEN.lock().map_err(|e| e.to_string())?,
            &token,
        )?;
        // A CLI or IDE process may have restarted independently; only the captured
        // desktop identities determine whether the app needs relaunching.
        let expected = targets.clone();
        let running: Vec<_> = {
            let (pids, _) = super::find_codex_processes().map_err(|e| e.to_string())?;
            capture_desktops(&pids)?.into_iter().map(|desktop| desktop.target).collect()
        };
        for target in &targets {
            if running.contains(target) { continue; }
            if !launch_desktop(target) {
                return Err("Could not launch Codex desktop. The account change was not undone. Open Codex manually.".into());
            }
        }
        let confirmed = wait_for_desktops(
            &expected,
            Duration::from_secs(20),
            || {
                let (pids, _) = super::find_codex_processes().map_err(|e| e.to_string())?;
                Ok(capture_desktops(&pids)?.into_iter().map(|desktop| desktop.target).collect())
            },
        );
        if !confirmed {
            return Err("Codex desktop did not appear within 20 seconds. The account change was not undone. Check the app or open it manually.".into());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn wait_for_desktops(
    expected: &[DesktopTarget],
    timeout: Duration,
    mut inspect: impl FnMut() -> Result<Vec<DesktopTarget>, String>,
) -> bool {
    let started = Instant::now();
    loop {
        if let Ok(running) = inspect() {
            if expected.iter().all(|target| running.contains(target)) {
                return true;
            }
        }
        if started.elapsed() >= timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn launch_desktop(target: &DesktopTarget) -> bool {
    match target {
        #[cfg(target_os = "macos")]
        DesktopTarget::MacBundle(bundle) => {
            is_codex_bundle(bundle)
                && super::command_succeeds(super::Command::new("open").arg("-a").arg(bundle))
        }
        #[cfg(windows)]
        DesktopTarget::WindowsExecutable(path) => {
            super::spawn_windows_codex_exe(std::path::Path::new(path))
        }
        #[cfg(windows)]
        DesktopTarget::WindowsIsolatedExecutable {
            path,
            user_data_dir,
        } => {
            use std::os::windows::process::CommandExt;
            let mut command = super::Command::new(path);
            command
                .creation_flags(super::CREATE_NO_WINDOW)
                .arg(format!("--user-data-dir={user_data_dir}"))
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            if let Some(parent) = std::path::Path::new(path).parent() {
                command.current_dir(parent);
            }
            command.spawn().is_ok()
        }
        #[cfg(windows)]
        DesktopTarget::WindowsAppId(id) => {
            use std::os::windows::process::CommandExt;
            valid_windows_app_id(id) && super::command_succeeds(
                super::Command::new("powershell.exe")
                    .creation_flags(super::CREATE_NO_WINDOW)
                    .args(["-NoProfile", "-NonInteractive", "-Command",
                        "$ErrorActionPreference = 'Stop'; Start-Process ('shell:AppsFolder\\' + $env:CODEX_SWITCHER_REOPEN_APP_ID)"])
                    .env("CODEX_SWITCHER_REOPEN_APP_ID", id),
            )
        }
        #[allow(unreachable_patterns)]
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn isolated_desktop_arguments_preserve_explicit_profiles() {
        let isolated = super::super::WindowsCodexProcess {
            process_id: 1,
            parent_process_id: 0,
            name: "ChatGPT.exe".into(),
            main_window_title: String::new(),
            executable_path: r"C:\Program Files\WindowsApps\OpenAI.Codex_26.1_x64__2p2nqsd0c76g0\app\ChatGPT.exe".into(),
            command_line: r#""C:\Program Files\WindowsApps\OpenAI.Codex_26.1_x64__2p2nqsd0c76g0\app\ChatGPT.exe" --user-data-dir=H:\codex-account-manager\test"#.into(),
        };
        assert!(super::super::is_windows_codex_root_process(&isolated));
        assert_eq!(
            windows_isolated_user_data_dir(
                r#""C:\Apps\ChatGPT.exe" --user-data-dir="H:\Test Profile""#
            ),
            Some(r"H:\Test Profile".into())
        );
        assert_eq!(
            windows_isolated_user_data_dir(
                r#""C:\Apps\ChatGPT.exe" --user-data-dir "H:\Test Profile""#
            ),
            Some(r"H:\Test Profile".into())
        );
        assert_eq!(
            windows_isolated_user_data_dir(r#""C:\Apps\ChatGPT.exe" --user-data-dir=relative"#),
            None
        );
        assert_eq!(
            windows_isolated_user_data_dir(r#""C:\Apps\ChatGPT.exe""#),
            None
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "Live isolated Codex only: requires its launch record and separate CODEX_HOME"]
    async fn live_isolated_desktop_auth_close_reopen() {
        use crate::types::AuthData;
        use base64::Engine;
        use std::os::windows::process::CommandExt;
        let root =
            std::path::Path::new(r"H:\codex-account-manager\.runtime\codex-real-test-20261012");
        let home = root.join("codex-home");
        assert_eq!(
            crate::auth::get_codex_home().unwrap(),
            home,
            "Refusing to touch the normal Codex home"
        );
        let record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("launch.json")).unwrap()).unwrap();
        let pid = record["TestPid"].as_u64().unwrap() as u32;
        let protected: Vec<u32> = record["ProtectedPids"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_u64().unwrap() as u32)
            .collect();
        assert!(!protected.contains(&pid), "Target is a protected process");
        let user_data = root
            .join("electron-user-data")
            .to_string_lossy()
            .into_owned();
        let processes = super::super::read_windows_codex_processes().unwrap();
        let process = processes
            .iter()
            .find(|p| p.process_id == pid)
            .expect("Isolated desktop is not running");
        assert_eq!(
            windows_isolated_user_data_dir(&process.command_line).as_deref(),
            Some(user_data.as_str()),
            "Refusing a desktop without the exact test profile"
        );
        let target = capture_desktops(&[pid])
            .unwrap()
            .pop()
            .expect("No isolated desktop identity");
        assert!(matches!(
            &target.target,
            DesktopTarget::WindowsIsolatedExecutable { .. }
        ));
        let protected_roots: Vec<u32> = processes
            .iter()
            .filter(|p| {
                protected.contains(&p.process_id) && super::super::is_windows_codex_root_process(p)
            })
            .map(|p| p.process_id)
            .collect();
        let store = crate::auth::load_accounts().unwrap();
        let now = chrono::Utc::now().timestamp();
        let baseline_auth = crate::auth::read_current_auth().unwrap();
        let baseline_access = baseline_auth
            .as_ref()
            .and_then(|auth| auth.tokens.as_ref())
            .map(|tokens| tokens.access_token.as_str());
        let account = store
            .accounts
            .iter()
            .find(|account| {
                if store.active_account_id.as_deref() == Some(&account.id) {
                    return false;
                }
                let AuthData::ChatGPT { access_token, .. } = &account.auth_data else {
                    return false;
                };
                if baseline_access == Some(access_token.as_str()) {
                    return false;
                }
                access_token
                    .split('.')
                    .nth(1)
                    .and_then(|p| {
                        base64::engine::general_purpose::URL_SAFE_NO_PAD
                            .decode(p)
                            .ok()
                    })
                    .and_then(|p| serde_json::from_slice::<serde_json::Value>(&p).ok())
                    .and_then(|p| p["exp"].as_i64())
                    .is_some_and(|expiry| expiry > now + 300)
            })
            .expect("No non-current account has an unexpired access token");
        println!(
            "TEST_ACCOUNT name={} type={} (credentials withheld)",
            account.name,
            account.plan_type.as_deref().unwrap_or("unknown")
        );
        let usage = crate::api::usage::get_account_usage(account)
            .await
            .expect("Test account usage request failed before closing");
        assert!(usage.error.is_none(), "Test account usage is unavailable");
        println!("TEST_ACCOUNT_AUTHENTICATED usage_api=true");
        let closed = super::super::close_codex_processes_for_pids(vec![pid], true, true).unwrap();
        assert!(closed.failed_pids.is_empty());
        assert!(closed.killed_pids.contains(&pid));
        for protected_pid in &protected_roots {
            assert!(
                super::super::process_exists(*protected_pid),
                "A protected desktop was closed"
            );
        }
        println!("TEST_DESKTOP_CLOSED pid={pid} protected_roots_alive=true");
        crate::auth::switch_to_account(account).unwrap();
        let written = crate::auth::read_current_auth().unwrap().unwrap();
        let AuthData::ChatGPT { access_token, .. } = &account.auth_data else {
            unreachable!()
        };
        assert!(
            written
                .tokens
                .as_ref()
                .is_some_and(|tokens| &tokens.access_token == access_token),
            "Test auth.json does not match the chosen account"
        );
        println!("AUTH_JSON_REPLACED verified=true");
        reopen_closed_codex_desktop(closed.reopen_token.expect("Missing reopen ticket"))
            .await
            .unwrap();
        let (pids, _) = super::super::find_codex_processes().unwrap();
        let new_desktop = capture_desktops(&pids)
            .unwrap()
            .into_iter()
            .find(|d| d.target == target.target)
            .expect("Reopened isolated desktop not found");
        assert_ne!(pid, new_desktop.pid);
        for protected_pid in &protected_roots {
            assert!(super::super::process_exists(*protected_pid));
        }
        println!(
            "TEST_DESKTOP_REOPENED pid={} protected_roots_alive=true",
            new_desktop.pid
        );
        let new_record = serde_json::json!({"TestPid":new_desktop.pid,"ProtectedPids":protected,"CodexHome":home,"UserData":user_data});
        std::fs::write(
            root.join("launch.json"),
            serde_json::to_vec_pretty(&new_record).unwrap(),
        )
        .unwrap();
        let desktop_path = windows_desktop_executable(process).unwrap();
        let cli = super::super::read_windows_codex_processes()
            .unwrap()
            .into_iter()
            .find(|p| {
                p.parent_process_id == new_desktop.pid
                    && p.name.eq_ignore_ascii_case("codex.exe")
                    && p.command_line.contains("app-server")
            })
            .map(|p| std::path::PathBuf::from(p.executable_path))
            .unwrap_or_else(|| {
                std::path::Path::new(&desktop_path)
                    .parent()
                    .unwrap()
                    .join("resources/codex.exe")
            });
        let status = super::super::Command::new(&cli)
            .creation_flags(super::super::CREATE_NO_WINDOW)
            .args([
                "-c",
                "cli_auth_credentials_store=\"file\"",
                "login",
                "status",
            ])
            .output()
            .unwrap();
        let status_text = format!(
            "{}{}",
            String::from_utf8_lossy(&status.stdout),
            String::from_utf8_lossy(&status.stderr)
        );
        assert!(
            status.status.success() && status_text.to_lowercase().contains("chatgpt"),
            "Codex CLI did not recognize the replaced login"
        );
        println!("CODEX_RECOGNIZED_AUTH login_status=true");
        let response = super::super::Command::new(&cli)
            .creation_flags(super::super::CREATE_NO_WINDOW)
            .current_dir(root)
            .args([
                "exec",
                "--ephemeral",
                "--skip-git-repo-check",
                "--sandbox",
                "read-only",
                "--json",
                "Reply exactly AUTH_TEST_OK. Do not use tools or inspect files.",
            ])
            .output()
            .unwrap();
        let content = String::from_utf8_lossy(&response.stdout);
        let completed = content
            .lines()
            .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .any(|event| {
                event["type"] == "item.completed"
                    && event["item"]["type"] == "agent_message"
                    && event["item"]["text"]
                        .as_str()
                        .is_some_and(|text| text.trim() == "AUTH_TEST_OK")
            });
        assert!(
            response.status.success() && completed,
            "The replaced account did not complete a real Codex inference request"
        );
        println!("REAL_CODEX_INFERENCE response=AUTH_TEST_OK");
    }

    #[test]
    fn launch_confirmation_requires_the_exact_desktop_and_handles_detection_failure() {
        let expected = vec![DesktopTarget::MacBundle("/Applications/ChatGPT.app".into())];
        assert!(wait_for_desktops(&expected, Duration::ZERO, || Ok(
            expected.clone()
        )));
        assert!(!wait_for_desktops(&expected, Duration::ZERO, || Ok(vec![])));
        assert!(!wait_for_desktops(&expected, Duration::ZERO, || Err(
            "query failed".into()
        )));
        assert!(!wait_for_desktops(&expected, Duration::ZERO, || Ok(vec![
            DesktopTarget::MacBundle("/Other/ChatGPT.app".into())
        ])));
    }

    #[test]
    fn extracts_exact_macos_bundle_with_spaces_and_rejects_helpers() {
        assert_eq!(
            mac_bundle_path(
                "/Users/test/My Apps/ChatGPT.app/Contents/MacOS/ChatGPT --flag",
                Some("ChatGPT")
            ),
            Some("/Users/test/My Apps/ChatGPT.app".into()),
        );
        assert_eq!(
            mac_bundle_path(
                "/Applications/Codex.app/Contents/MacOS/Codex",
                Some("Codex")
            ),
            Some("/Applications/Codex.app".into())
        );
        assert_eq!(
            mac_bundle_path(
                "/Applications/ChatGPT.app/Contents/MacOS/ChatGPTHelper",
                Some("ChatGPT")
            ),
            None
        );
        assert_eq!(
            mac_bundle_path(
                "/Applications/ChatGPT.app/Contents/Resources/codex app-server",
                Some("codex")
            ),
            None
        );
        assert_eq!(mac_bundle_path("codex", Some("codex")), None);
    }

    fn windows_process(path: &str, command: &str) -> super::super::WindowsCodexProcess {
        super::super::WindowsCodexProcess {
            name: "ChatGPT.exe".into(),
            process_id: 100,
            parent_process_id: 1,
            executable_path: path.into(),
            command_line: command.into(),
            main_window_title: "Codex".into(),
        }
    }

    #[test]
    fn windows_package_requires_codex_identity_and_preserves_exact_path() {
        let path =
            r"C:\Program Files\WindowsApps\OpenAI.Codex_1.2.3.0_x64__2p2nqsd0c76g0\app\ChatGPT.exe";
        assert_eq!(
            windows_desktop_executable(&windows_process(path, "")),
            Some(path.into())
        );
        assert_eq!(
            windows_desktop_executable(&windows_process("", &format!("\"{path}\" --flag"))),
            Some(path.into())
        );
        assert_eq!(
            windows_desktop_executable(&windows_process(path, "--type=renderer")),
            None
        );
        assert_eq!(
            windows_desktop_executable(&windows_process(r"C:\Other\ChatGPT.exe", "")),
            None
        );
        assert_eq!(
            windows_desktop_executable(&windows_process(
                &path.replace("2p2nqsd0c76g0", "other"),
                ""
            )),
            None
        );
        let mut legacy = windows_process(r"C:\Users\test\Apps\Codex\Codex.exe", "");
        legacy.name = "Codex.exe".into();
        assert_eq!(
            windows_desktop_executable(&legacy),
            Some(legacy.executable_path.clone())
        );
        legacy.executable_path = r"C:\Apps\Codex\resources\codex.exe".into();
        assert_eq!(windows_desktop_executable(&legacy), None);
        legacy.executable_path = "codex.exe".into();
        assert_eq!(windows_desktop_executable(&legacy), None);
    }

    #[test]
    fn windows_app_id_rejects_other_apps_and_malformed_identifiers() {
        assert!(valid_windows_app_id("OpenAI.Codex_2p2nqsd0c76g0!App"));
        for id in [
            "OpenAI.ChatGPT_2p2nqsd0c76g0!App",
            "OpenAI.Codex_other!App",
            "OpenAI.Codex_2p2nqsd0c76g0!",
            "OpenAI.Codex_2p2nqsd0c76g0!App\n",
            "OpenAI.Codex_2p2nqsd0c76g0!App!Other",
        ] {
            assert!(!valid_windows_app_id(id));
        }
    }

    #[test]
    fn reopens_only_closed_roots_and_deduplicates_same_installation() {
        let target = DesktopTarget::MacBundle("/Applications/ChatGPT.app".into());
        let desktops = vec![
            CapturedDesktop {
                pid: 1,
                target: target.clone(),
            },
            CapturedDesktop {
                pid: 2,
                target: target.clone(),
            },
            CapturedDesktop {
                pid: 3,
                target: DesktopTarget::MacBundle("/Other/Codex.app".into()),
            },
        ];
        assert_eq!(closed_targets(desktops, &[1, 2]), vec![target]);
        assert!(closed_targets(vec![], &[1]).is_empty());
    }

    #[test]
    fn reopen_tickets_are_one_use_and_expire() {
        let mut ticket = Some(ReopenTicket {
            token: "token".into(),
            created_at: Instant::now(),
            targets: vec![DesktopTarget::WindowsAppId(
                "OpenAI.Codex_2p2nqsd0c76g0!App".into(),
            )],
        });
        assert!(take_targets(&mut ticket, "wrong").is_err());
        assert_eq!(take_targets(&mut ticket, "token").unwrap().len(), 1);
        assert!(take_targets(&mut ticket, "token").is_err());
        let mut expired = Some(ReopenTicket {
            token: "expired".into(),
            created_at: Instant::now() - Duration::from_secs(121),
            targets: vec![DesktopTarget::WindowsExecutable("C:\\Codex.exe".into())],
        });
        assert!(take_targets(&mut expired, "expired").is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "Read-only inspection of live desktop processes; run explicitly"]
    fn inspect_live_desktop_targets() {
        let (pids, _) = super::super::find_codex_processes().unwrap();
        let desktops = capture_desktops(&pids).unwrap();
        for desktop in &desktops {
            println!("Desktop PID {}: {:?}", desktop.pid, desktop.target);
        }
        assert!(!desktops.is_empty(), "No running Codex desktop found");
    }
}
