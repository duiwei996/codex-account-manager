#[cfg(target_os = "macos")]
use crate::auth::load_app_settings;
#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadata, CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

#[cfg(target_os = "macos")]
use crate::auth::update_app_settings;
#[cfg(target_os = "macos")]
use crate::types::AppSettings;
#[cfg(target_os = "macos")]
pub(crate) use crate::types::DockDisplayMode;

#[cfg(target_os = "macos")]
const DESKTOP_REOPEN_SETTINGS_ID: &str = "desktop-reopen-settings";
#[cfg(target_os = "macos")]
pub(crate) const DOCK_SHOW_IN_DOCK_ID: &str = "dock-display-show-in-dock";
#[cfg(target_os = "macos")]
pub(crate) const DOCK_MENU_BAR_ONLY_ID: &str = "dock-display-menu-bar-only";

/// Pick a locale-specific menu label without changing IDs or shortcuts.
pub(crate) fn localized<'a>(zh: bool, en: &'a str, chinese: &'a str) -> &'a str {
    if zh {
        chinese
    } else {
        en
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        apply_saved_dock_display_mode(app);
        refresh(app)?;
        app.on_menu_event(handle_menu_event);
    }
    #[cfg(not(target_os = "macos"))]
    {
        // On non-macOS platforms, Codex Account Manager uses a frameless custom UI (decorations: false).
        // Settings are managed in the tray menu and in-app UI, so no native window menu is attached.
        refresh(app)?;
    }
    Ok(())
}

pub fn refresh<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let settings = load_app_settings().unwrap_or_default();
        let menu = build_menu(app, &settings)?;
        app.set_menu(menu)?;
    }
    if let Err(error) = app.emit("app-settings-changed", ()) {
        eprintln!("Failed to notify settings changes: {error}");
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn handle_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let item_id = event.id();

    if item_id.as_ref() == DESKTOP_REOPEN_SETTINGS_ID {
        crate::commands::open_main_window(app.clone());
        if let Err(error) = app.emit_to("main", "desktop-reopen-settings-requested", ()) {
            eprintln!("Failed to open desktop reopen settings: {error}");
        }
        return;
    }

    #[cfg(target_os = "macos")]
    if let Some(mode) = dock_display_mode_for_item(item_id.as_ref()) {
        update_dock_display_mode(app, mode);
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn dock_display_mode_for_item(item_id: &str) -> Option<DockDisplayMode> {
    Some(match item_id {
        DOCK_SHOW_IN_DOCK_ID => DockDisplayMode::ShowInDock,
        DOCK_MENU_BAR_ONLY_ID => DockDisplayMode::MenuBarOnly,
        _ => return None,
    })
}

#[cfg(target_os = "macos")]
pub(crate) fn update_dock_display_mode(app: &AppHandle, mode: DockDisplayMode) {
    if let Err(error) = set_dock_display_mode(app, mode) {
        eprintln!("Failed to update Dock display mode: {error}");
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn set_dock_display_mode<R: Runtime>(
    app: &AppHandle<R>,
    mode: DockDisplayMode,
) -> anyhow::Result<AppSettings> {
    let settings = update_app_settings(|settings| {
        settings.dock_display_mode = mode;
        Ok(settings.clone())
    })?;
    apply_dock_display_mode(app, mode);

    if let Err(error) = refresh(app) {
        eprintln!("Failed to refresh app menu: {error}");
    }
    crate::tray::refresh(app);
    Ok(settings)
}

#[cfg(target_os = "macos")]
fn apply_saved_dock_display_mode<R: Runtime>(app: &AppHandle<R>) {
    let settings = load_app_settings().unwrap_or_default();
    apply_dock_display_mode(app, settings.dock_display_mode);
}

#[cfg(target_os = "macos")]
fn apply_dock_display_mode<R: Runtime>(app: &AppHandle<R>, mode: DockDisplayMode) {
    let visible = mode == DockDisplayMode::ShowInDock;
    if let Err(error) = app.set_dock_visibility(visible) {
        eprintln!("Failed to update Dock visibility: {error}");
    }
}

#[cfg(target_os = "macos")]
fn build_menu<R: Runtime>(app: &AppHandle<R>, settings: &AppSettings) -> tauri::Result<Menu<R>> {
    let zh = settings.ui_language == "zh-CN";
    let pkg_info = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };

    #[cfg(target_os = "macos")]
    let dock_settings = Submenu::with_items(
        app,
        localized(zh, "Dock Icon", "程序坞图标"),
        true,
        &[
            &CheckMenuItem::with_id(
                app,
                DOCK_SHOW_IN_DOCK_ID,
                localized(zh, "Show in Dock", "在程序坞显示"),
                true,
                settings.dock_display_mode == DockDisplayMode::ShowInDock,
                None::<&str>,
            )?,
            &CheckMenuItem::with_id(
                app,
                DOCK_MENU_BAR_ONLY_ID,
                localized(zh, "Menu Bar Only", "仅显示菜单栏"),
                true,
                settings.dock_display_mode == DockDisplayMode::MenuBarOnly,
                None::<&str>,
            )?,
        ],
    )?;

    let desktop_reopen_settings = MenuItem::with_id(
        app,
        DESKTOP_REOPEN_SETTINGS_ID,
        localized(zh, "Account switching...", "账号切换方式…"),
        cfg!(any(target_os = "macos", windows)),
        None::<&str>,
    )?;

    #[cfg(target_os = "macos")]
    let settings_menu = Submenu::with_items(
        app,
        localized(zh, "Settings", "设置"),
        true,
        &[&dock_settings, &desktop_reopen_settings],
    )?;

    #[cfg(not(target_os = "macos"))]
    let settings_menu = Submenu::with_items(
        app,
        localized(zh, "Settings", "设置"),
        true,
        &[&desktop_reopen_settings],
    )?;

    let window_menu = Submenu::with_items(
        app,
        localized(zh, "Window", "窗口"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(localized(zh, "Minimize", "最小化")))?,
            &PredefinedMenuItem::maximize(app, Some(localized(zh, "Maximize", "最大化")))?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(
                app,
                Some(localized(zh, "Close Window", "关闭窗口")),
            )?,
        ],
    )?;

    let help_menu = Submenu::with_items(app, localized(zh, "Help", "帮助"), true, &[])?;

    Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                pkg_info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(
                        app,
                        Some(localized(zh, "About", "关于")),
                        Some(about_metadata),
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    &settings_menu,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, Some(localized(zh, "Services", "服务")))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, Some(localized(zh, "Hide", "隐藏")))?,
                    &PredefinedMenuItem::hide_others(
                        app,
                        Some(localized(zh, "Hide Others", "隐藏其他")),
                    )?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, Some(localized(zh, "Quit", "退出")))?,
                ],
            )?,
            #[cfg(not(any(
                target_os = "linux",
                target_os = "dragonfly",
                target_os = "freebsd",
                target_os = "netbsd",
                target_os = "openbsd"
            )))]
            &Submenu::with_items(
                app,
                localized(zh, "File", "文件"),
                true,
                &[
                    &PredefinedMenuItem::close_window(
                        app,
                        Some(localized(zh, "Close Window", "关闭窗口")),
                    )?,
                    #[cfg(not(target_os = "macos"))]
                    &PredefinedMenuItem::quit(app, Some(localized(zh, "Quit", "退出")))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                localized(zh, "Edit", "编辑"),
                true,
                &[
                    &PredefinedMenuItem::undo(app, Some(localized(zh, "Undo", "撤销")))?,
                    &PredefinedMenuItem::redo(app, Some(localized(zh, "Redo", "重做")))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::cut(app, Some(localized(zh, "Cut", "剪切")))?,
                    &PredefinedMenuItem::copy(app, Some(localized(zh, "Copy", "复制")))?,
                    &PredefinedMenuItem::paste(app, Some(localized(zh, "Paste", "粘贴")))?,
                    &PredefinedMenuItem::select_all(
                        app,
                        Some(localized(zh, "Select All", "全选")),
                    )?,
                ],
            )?,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                localized(zh, "View", "视图"),
                true,
                &[&PredefinedMenuItem::fullscreen(
                    app,
                    Some(localized(zh, "Enter Full Screen", "全屏")),
                )?],
            )?,
            #[cfg(not(target_os = "macos"))]
            &settings_menu,
            &window_menu,
            &help_menu,
        ],
    )
}
