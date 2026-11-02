//! Read process metadata in-process. A polling query must never launch a console
//! program: a new process can fail DLL initialization while Windows is logging off.

use super::WindowsCodexProcess;
use anyhow::Context;
use std::collections::HashMap;
use windows_sys::core::BOOL;
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM},
    UI::WindowsAndMessaging::{
        EnumWindows, GetSystemMetrics, GetWindow, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsWindowVisible, GW_OWNER, SM_SHUTTINGDOWN,
    },
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ProcessEntry {
    name: String,
    process_id: u32,
    parent_process_id: u32,
    command_line: Option<String>,
    executable_path: Option<String>,
}

fn ensure_session_active() -> anyhow::Result<()> {
    // Query the current state instead of latching it, so a cancelled shutdown
    // does not permanently disable process detection.
    if unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) } != 0 {
        anyhow::bail!("Windows session is shutting down; process detection is unavailable");
    }
    Ok(())
}

pub(super) fn read_codex_processes() -> anyhow::Result<Vec<WindowsCodexProcess>> {
    read_while_active(ensure_session_active, || {
        // Query the same metadata as Get-CimInstance, without starting PowerShell.
        // Restrict the provider query to the executable names used by the classifier.
        let connection = wmi::WMIConnection::new().context("failed to connect to Windows WMI")?;
        let entries: Vec<ProcessEntry> = connection
            .raw_query(
                "SELECT Name, ProcessId, ParentProcessId, CommandLine, ExecutablePath \
                 FROM Win32_Process WHERE Name = 'Codex.exe' OR Name = 'ChatGPT.exe'",
            )
            .context("failed to query Windows process list")?;
        let mut titles: HashMap<u32, String> = entries
            .iter()
            .map(|entry| (entry.process_id, String::new()))
            .collect();

        // EnumWindows is synchronous; the map remains exclusively borrowed and
        // alive for the entire callback enumeration.
        if unsafe { EnumWindows(Some(collect_window_title), &mut titles as *mut _ as LPARAM) } == 0
        {
            return Err(std::io::Error::last_os_error()).context("failed to enumerate app windows");
        }

        Ok(entries
            .into_iter()
            .map(|entry| WindowsCodexProcess {
                name: entry.name,
                process_id: entry.process_id,
                parent_process_id: entry.parent_process_id,
                command_line: entry.command_line.unwrap_or_default(),
                executable_path: entry.executable_path.unwrap_or_default(),
                main_window_title: titles.remove(&entry.process_id).unwrap_or_default(),
            })
            .collect())
    })
}

fn read_while_active<T>(
    ensure_active: impl Fn() -> anyhow::Result<()>,
    read: impl FnOnce() -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    ensure_active()?;
    let result = read()?;
    // Do not report "safe to switch" if shutdown began during the query.
    ensure_active()?;
    Ok(result)
}

unsafe extern "system" fn collect_window_title(hwnd: HWND, data: LPARAM) -> BOOL {
    let titles = &mut *(data as *mut HashMap<u32, String>);
    let mut pid = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    let Some(title) = titles.get_mut(&pid) else {
        return 1;
    };
    // Match Process.MainWindowTitle: a visible, unowned top-level window.
    if !title.is_empty() || IsWindowVisible(hwnd) == 0 || !GetWindow(hwnd, GW_OWNER).is_null() {
        return 1;
    }
    let length = GetWindowTextLengthW(hwnd);
    if length > 0 {
        let mut buffer = vec![0; (length as usize + 1).min(32768)];
        let copied = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
        if copied > 0 {
            *title = String::from_utf16_lossy(&buffer[..copied as usize]);
        }
    }
    1
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn shutdown_skips_the_provider_instead_of_reporting_no_processes() {
        let result: anyhow::Result<Vec<WindowsCodexProcess>> = read_while_active(
            || anyhow::bail!("shutting down"),
            || panic!("must not query WMI during shutdown"),
        );
        assert!(result.is_err());
    }

    #[test]
    fn shutdown_during_query_rejects_an_empty_snapshot() {
        let checks = Cell::new(0);
        let result = read_while_active(
            || {
                checks.set(checks.get() + 1);
                anyhow::ensure!(checks.get() == 1, "shutting down");
                Ok(())
            },
            || Ok(Vec::<WindowsCodexProcess>::new()),
        );
        assert!(result.is_err());
    }

    #[test]
    fn detection_resumes_after_a_cancelled_shutdown() {
        let shutting_down = Cell::new(true);
        let ensure_active = || {
            anyhow::ensure!(!shutting_down.get(), "shutting down");
            Ok(())
        };
        assert!(read_while_active(ensure_active, || Ok(42)).is_err());
        shutting_down.set(false);
        assert_eq!(read_while_active(ensure_active, || Ok(42)).unwrap(), 42);
    }

    #[test]
    fn restricted_process_metadata_can_be_null() {
        let entry: ProcessEntry = serde_json::from_str(
            r#"{"Name":"Codex.exe","ProcessId":10,"ParentProcessId":1,
                "CommandLine":null,"ExecutablePath":null}"#,
        )
        .unwrap();
        assert!(entry.command_line.is_none());
        assert!(entry.executable_path.is_none());
    }

    #[test]
    fn native_query_reads_the_current_process_without_a_shell() {
        let connection = wmi::WMIConnection::new().unwrap();
        let entries: Vec<ProcessEntry> = connection
            .raw_query(format!(
                "SELECT Name, ProcessId, ParentProcessId, CommandLine, ExecutablePath \
                 FROM Win32_Process WHERE ProcessId = {}",
                std::process::id()
            ))
            .unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].process_id, std::process::id());
        assert!(entries[0]
            .command_line
            .as_deref()
            .is_some_and(|s| !s.is_empty()));
        assert!(entries[0]
            .executable_path
            .as_deref()
            .is_some_and(|s| !s.is_empty()));
        read_codex_processes().unwrap();
    }
}
