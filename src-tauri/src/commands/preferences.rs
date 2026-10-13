use crate::auth::{load_app_settings, update_app_settings};
use crate::types::{AppSettings, RefreshScope};
use tauri::{AppHandle, Emitter, Manager, Runtime};
#[cfg(desktop)]
use tauri_plugin_autostart::ManagerExt;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct RuntimePreferences {
    pub autostart_enabled: Option<bool>,
    pub startup_minimized: bool,
    pub automatic_update_checks: bool,
    pub refresh_scope: RefreshScope,
    pub refresh_interval_seconds: u64,
}

impl RuntimePreferences {
    pub fn from_settings(settings: AppSettings, autostart_enabled: Option<bool>) -> Self {
        let refresh_interval_seconds = settings.usage_refresh_delay_seconds(true);
        Self {
            autostart_enabled,
            startup_minimized: settings.startup_minimized,
            automatic_update_checks: settings.automatic_update_checks,
            refresh_scope: settings.refresh_scope,
            refresh_interval_seconds,
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        if ![30, 60, 120, 300, 600].contains(&self.refresh_interval_seconds) {
            return Err("Unsupported refresh interval".into());
        }
        Ok(())
    }
}

#[tauri::command]
pub fn get_runtime_preferences(app: AppHandle) -> Result<RuntimePreferences, String> {
    let settings = load_app_settings().map_err(|e| e.to_string())?;
    #[cfg(desktop)]
    let enabled = Some(app.autolaunch().is_enabled().map_err(|e| e.to_string())?);
    #[cfg(not(desktop))]
    let enabled = {
        let _ = app;
        None
    };
    Ok(RuntimePreferences::from_settings(settings, enabled))
}

#[tauri::command]
pub fn set_runtime_preferences(
    app: AppHandle,
    preferences: RuntimePreferences,
) -> Result<RuntimePreferences, String> {
    preferences.validate()?;
    #[cfg(desktop)]
    let previous = app.autolaunch().is_enabled().map_err(|e| e.to_string())?;
    #[cfg(desktop)]
    if let Some(enabled) = preferences.autostart_enabled {
        if enabled != previous {
            if enabled {
                app.autolaunch().enable()
            } else {
                app.autolaunch().disable()
            }
            .map_err(|e| e.to_string())?;
        }
    }
    let saved = save_runtime_preferences(&preferences);
    if let Err(error) = saved {
        #[cfg(desktop)]
        if preferences
            .autostart_enabled
            .is_some_and(|enabled| enabled != previous)
        {
            let _ = if previous {
                app.autolaunch().enable()
            } else {
                app.autolaunch().disable()
            };
        }
        return Err(error);
    }
    let actual = get_runtime_preferences(app.clone())?;
    app.emit("app-settings-changed", ())
        .map_err(|e| e.to_string())?;
    Ok(actual)
}

pub fn save_runtime_preferences(preferences: &RuntimePreferences) -> Result<(), String> {
    preferences.validate()?;
    update_app_settings(|settings| {
        settings.startup_minimized = preferences.startup_minimized;
        settings.automatic_update_checks = preferences.automatic_update_checks;
        settings.refresh_scope = preferences.refresh_scope;
        settings.refresh_interval_seconds = preferences.refresh_interval_seconds;
        if preferences.autostart_enabled.is_some() {
            settings.autostart_initialized = true;
        }
        Ok(())
    })
    .map_err(|e| e.to_string())
}

#[cfg(desktop)]
pub fn initialize_startup<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let settings = load_app_settings().map_err(|e| e.to_string())?;
    // Development builds must never register a temporary executable at login.
    if !cfg!(debug_assertions) && !settings.autostart_initialized {
        app.autolaunch().enable().map_err(|e| e.to_string())?;
        update_app_settings(|settings| {
            settings.autostart_initialized = true;
            Ok(())
        })
        .map_err(|e| e.to_string())?;
    }
    if std::env::args().any(|arg| arg == "--autostart") && settings.startup_minimized {
        // A hidden tray must leave the main window visible for recovery.
        let recoverable = settings.tray_display_mode != crate::types::TrayDisplayMode::Hidden
            || (cfg!(target_os = "macos")
                && settings.dock_display_mode == crate::types::DockDisplayMode::ShowInDock);
        if recoverable {
            if let Some(window) = app.get_webview_window("main") {
                window.hide().map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_settings_default_to_current_and_preserve_explicit_choices() {
        let old: AppSettings = serde_json::from_str(r#"{"ui_language":"en-US"}"#).unwrap();
        assert_eq!(old.refresh_scope, RefreshScope::Current);
        assert!(old.startup_minimized && old.automatic_update_checks);
        let stored: AppSettings = serde_json::from_str(r#"{"startup_minimized":false,"automatic_update_checks":false,"refresh_scope":"all","refresh_interval_seconds":300,"autostart_initialized":true}"#).unwrap();
        assert!(!stored.startup_minimized && !stored.automatic_update_checks);
        assert!(stored.autostart_initialized);
        assert_eq!(stored.refresh_scope, RefreshScope::All);
        assert_eq!(stored.refresh_interval_seconds, 300);
    }
    #[test]
    fn rejects_zero_and_unbounded_poll_intervals() {
        let mut preferences = RuntimePreferences::from_settings(AppSettings::default(), None);
        for seconds in [0, 1, 31, u64::MAX] {
            preferences.refresh_interval_seconds = seconds;
            assert!(preferences.validate().is_err());
        }
        preferences.refresh_interval_seconds = 120;
        assert!(preferences.validate().is_ok());
    }

    #[test]
    fn native_polling_slows_in_background_and_sanitizes_invalid_stored_intervals() {
        let mut settings = AppSettings::default();
        assert_eq!(settings.usage_refresh_delay_seconds(true), 60);
        assert_eq!(settings.usage_refresh_delay_seconds(false), 300);
        settings.refresh_interval_seconds = 120;
        assert_eq!(settings.usage_refresh_delay_seconds(false), 600);
        for invalid in [0, 1, u64::MAX] {
            settings.refresh_interval_seconds = invalid;
            assert_eq!(settings.usage_refresh_delay_seconds(true), 60);
            assert_eq!(
                RuntimePreferences::from_settings(settings.clone(), None).refresh_interval_seconds,
                60
            );
        }
    }
}
