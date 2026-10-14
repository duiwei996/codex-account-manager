import { CenteredSelect } from "./CenteredSelect";
import { localizeError } from "../lib/errors";
import { useCallback, useEffect, useRef, useState } from "react";
import { invokeBackend, isTauriRuntime } from "../lib/platform";
import type { DockDisplayMode } from "../types";
import { setLocale, tr, useLocale } from "../lib/i18n";
import { TimedWarmupEditor } from "./TimedWarmupEditor";
import { ActionIcon } from "./ActionIcon";
import type { ThemeMode } from "../lib/theme";
import type { AppUpdater } from "../hooks/useAppUpdater";
import { UpdateSettings } from "./UpdateSettings";
import { ToggleSwitch } from "./ToggleSwitch";
import type { RuntimePreferencesController } from "../hooks/useRuntimePreferences";

type TrayDisplayMode = "icon_and_session" | "active_usage_text" | "hidden";
interface DisplaySettings {
  account_switch_mode: "direct" | "force_close";
  tray_display_mode: TrayDisplayMode;
  dock_display_mode: DockDisplayMode | null;
}

interface SettingsModalProps {
  runtimePreferences: RuntimePreferencesController;
  updater: AppUpdater;
  theme: ThemeMode;
  onThemeChange: (theme: ThemeMode) => void;
  autoWarmupEnabled: boolean;
  autoWarmupLabel: string;
  onAutoWarmupChange: (enabled: boolean) => void;
  warmupAvailable: boolean;
  timedWarmupEnabled: boolean;
  timedWarmupTimes: string[];
  timedWarmupLabel: string;
  onTimedWarmupChange: (enabled: boolean) => void;
  onTimedWarmupTimesChange: (times: string[]) => void;
  onClose: () => void;
}

export function SettingsModal({
  runtimePreferences,
  updater,
  theme, onThemeChange,
  autoWarmupEnabled, autoWarmupLabel, onAutoWarmupChange, warmupAvailable,
  timedWarmupEnabled, timedWarmupTimes, timedWarmupLabel,
  onTimedWarmupChange, onTimedWarmupTimesChange,
  onClose,
}: SettingsModalProps) {
  const locale = useLocale();
  const [section, setSection] = useState<"general" | "accounts" | "updates">("general");
  const { preferences, change, ready, saving: savingPreferences, error: preferencesError } = runtimePreferences;
  const translate = (key: Parameters<typeof tr>[0]) => tr(key, locale);
  const [displaySettings, setDisplaySettings] = useState<DisplaySettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingTimes, setEditingTimes] = useState(false);
  const requestId = useRef(0);
  const desktop = isTauriRuntime();
  const loadDisplaySettings = useCallback(async () => {
    const currentRequest = ++requestId.current;
    try {
      const settings = await invokeBackend<DisplaySettings>("get_display_settings");
      if (currentRequest === requestId.current) {
        setDisplaySettings(settings);
        setError(null);
      }
    } catch (err) {
      if (currentRequest === requestId.current) setError(String(err));
    }
  }, []);

  useEffect(() => {
    if (!desktop) { void loadDisplaySettings(); return; }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const stop = await listen("app-settings-changed", () => {
        void loadDisplaySettings();
      });
      if (disposed) stop();
      else {
        unlisten = stop;
        void loadDisplaySettings();
      }
    }).catch((err) => {
      if (!disposed) setError(String(err));
    });
    return () => {
      disposed = true;
      requestId.current += 1;
      unlisten?.();
    };
  }, [desktop, loadDisplaySettings]);

  const changeDisplaySetting = async (command: string, mode: string) => {
    setSaving(true);
    setError(null);
    try {
      await invokeBackend(command, { mode });
      // Changing tray visibility can also adjust the Dock mode, and vice versa.
      await loadDisplaySettings();
    } catch (err) {
      requestId.current += 1;
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const selectClassName = "w-48 max-w-[60%] shrink-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 disabled:opacity-50";
  const rowClassName = "flex items-center justify-between gap-4 py-4";
  const labelClassName = "text-sm font-medium text-gray-900 dark:text-gray-100";


  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="settings-title" className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
        <div className="flex shrink-0 items-center justify-between border-b border-gray-100 p-5 dark:border-gray-800">
          <h2 id="settings-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">{translate("Settings")}</h2>
          <button onClick={onClose} disabled={saving || savingPreferences} aria-label={translate("Close")} className="rounded-lg px-2 py-1 text-gray-400 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-800">✕</button>
        </div>
        <div role="tablist" aria-label={translate("Settings")} className="flex shrink-0 gap-1 border-b border-gray-100 px-5 py-3 dark:border-gray-800">
          {(["general", "accounts", "updates"] as const).map(key => <button key={key} id={`settings-${key}`} role="tab" aria-selected={section === key} aria-controls="settings-panel" tabIndex={section === key ? 0 : -1} onClick={() => setSection(key)}
            onKeyDown={event => { const keys = ["general", "accounts", "updates"] as const; const index = keys.indexOf(key); if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = keys[event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3]; setSection(next); document.getElementById(`settings-${next}`)?.focus(); } }}
            className={`min-w-0 flex-1 rounded-lg px-2 py-2 text-sm font-medium ${section === key ? "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" : "text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"}`}>
            {translate(key === "general" ? "General" : key === "accounts" ? "Accounts and automation" : "Updates and about")}
          </button>)}
        </div>
        <div id="settings-panel" role="tabpanel" aria-labelledby={`settings-${section}`} className="overflow-y-auto px-5 py-2">
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            {section === "general" && <>
            <div className={rowClassName}>
              <label htmlFor="app-language" className={labelClassName}>{translate("Language")}</label>
              <CenteredSelect id="app-language" value={locale} onChange={(event) => setLocale(event.target.value as "zh-CN" | "en-US")} className={selectClassName}>
                <option value="zh-CN">{translate("Simplified Chinese")}</option>
                <option value="en-US">{translate("English")}</option>
              </CenteredSelect>
            </div>
            <div className={rowClassName}>
              <label htmlFor="app-theme" className={labelClassName}>{translate("Appearance")}</label>
              <CenteredSelect id="app-theme" value={theme} onChange={(event) => onThemeChange(event.target.value as ThemeMode)} className={selectClassName}>
                <option value="light">{translate("Light")}</option>
                <option value="dark">{translate("Dark")}</option>
              </CenteredSelect>
            </div>
            {desktop && <>
              <div className={rowClassName}>
                <div><label htmlFor="app-autostart" className={labelClassName}>{translate("Launch at login")}</label><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{translate("Start automatically when you sign in to your computer.")}</p></div>
                <ToggleSwitch id="app-autostart" label={translate("Launch at login")} checked={preferences.autostart_enabled === true} disabled={!ready || savingPreferences || preferences.autostart_enabled === null} onChange={enabled => void change({ autostart_enabled: enabled })} />
              </div>
              <div className={rowClassName}>
                <div><label htmlFor="startup-minimized" className={labelClassName}>{translate("Start minimized to tray")}</label><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{translate("Applies to login startup. Opening the app manually shows its window.")}</p></div>
                <ToggleSwitch id="startup-minimized" label={translate("Start minimized to tray")} checked={preferences.startup_minimized} disabled={!ready || savingPreferences} onChange={enabled => void change({ startup_minimized: enabled })} />
              </div>
            </>}
            {desktop && displaySettings && <>
              <div className={rowClassName}>
                <label htmlFor="tray-display-mode" className={labelClassName}>{translate("Tray")}</label>
                <CenteredSelect id="tray-display-mode" value={displaySettings.tray_display_mode} disabled={saving} onChange={(event) => void changeDisplaySetting("set_tray_display_mode", event.target.value)} className={selectClassName}>
                  <option value="icon_and_session">{translate("Icon + Session")}</option>
                  <option value="active_usage_text">{translate("Hourly + Weekly")}</option>
                  <option value="hidden">{translate("Hidden")}</option>
                </CenteredSelect>
              </div>
              {displaySettings.dock_display_mode !== null && <div>
                <div className={rowClassName}>
                  <label htmlFor="dock-display-mode" className={labelClassName}>{translate("Dock Icon")}</label>
                  <CenteredSelect id="dock-display-mode" value={displaySettings.dock_display_mode} disabled={saving} onChange={(event) => void changeDisplaySetting("set_dock_display_mode", event.target.value)} className={selectClassName}>
                    <option value="show_in_dock">{translate("Show in Dock")}</option>
                    <option value="menu_bar_only">{translate("Menu Bar Only")}</option>
                  </CenteredSelect>
                </div>
                <p className="pb-3 text-xs text-gray-500 dark:text-gray-400">{translate("At least one of the Dock or tray icons stays visible so you can reopen Codex Account Manager.")}</p>
              </div>}
            </>}
            </>}
            {section === "accounts" && <>
            <div>
              <div className={rowClassName}>
                <div><label htmlFor="refresh-scope" className={labelClassName}>{translate("Automatic refresh scope")}</label><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{translate("Refresh the account in use or valid accounts in the selected category.")}</p></div>
                <CenteredSelect id="refresh-scope" className={selectClassName} value={preferences.refresh_scope} disabled={!ready || savingPreferences} onChange={event => void change({ refresh_scope: event.target.value as "current" | "category" })}>
                  <option value="current">{translate("Current account")}</option><option value="category">{translate("Current category")}</option>
                </CenteredSelect>
              </div>
              <div className={rowClassName}>
                <div><label htmlFor="refresh-interval" className={labelClassName}>{translate("Automatic refresh interval")}</label><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{translate("Background refresh runs at one fifth of the foreground frequency.")}</p></div>
                <CenteredSelect id="refresh-interval" className={selectClassName} value={preferences.refresh_interval_seconds} disabled={!ready || savingPreferences} onChange={event => void change({ refresh_interval_seconds: Number(event.target.value) })}>
                  {[30, 60, 120, 300, 600].map(seconds => <option key={seconds} value={seconds}>{seconds < 60 ? translate("30 seconds") : `${seconds / 60} ${translate("minutes")}`}</option>)}
                </CenteredSelect>
              </div>
            </div>
            {displaySettings && <div>
              <div className={rowClassName}>
                <div><label htmlFor="account-switch-mode" className={labelClassName}>{translate("Account switching")}</label><p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{translate("Force switching closes Codex and reopens it after switching. Direct switching leaves Codex running.")}</p></div>
                <CenteredSelect id="account-switch-mode" value={displaySettings.account_switch_mode} disabled={saving} onChange={(event) => void changeDisplaySetting("set_account_switch_mode", event.target.value)} className={selectClassName}>
                  <option value="force_close">{translate("Force close and switch")}</option>
                  <option value="direct">{translate("Switch directly")}</option>
                </CenteredSelect>
              </div>
            </div>}
            <div>
              <div className={rowClassName}>
                <div><label htmlFor="auto-warmup" className={labelClassName}>{translate("Auto Warm Up")}</label><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{autoWarmupLabel}</p></div>
                <ToggleSwitch id="auto-warmup" checked={autoWarmupEnabled} disabled={!warmupAvailable} onChange={onAutoWarmupChange} label={translate("Auto Warm Up")} />
              </div>
            </div>
            <div>
              <div className={rowClassName}>
                <div><label htmlFor="timed-warmup" className={labelClassName}>{translate("Timed warm-up")}</label><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{timedWarmupLabel}</p></div>
                <ToggleSwitch id="timed-warmup" checked={timedWarmupEnabled} disabled={!desktop} onChange={onTimedWarmupChange} label={translate("Timed warm-up")} />
              </div>
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="flex flex-wrap gap-2">
                  {timedWarmupTimes.length === 0 ? <p className="text-xs text-gray-400">{translate("No times added yet.")}</p> : timedWarmupTimes.map(time => <span key={time} className="rounded-lg bg-gray-100 px-3 py-1.5 font-mono text-sm text-gray-700 dark:bg-gray-800 dark:text-gray-200">{time}</span>)}
                </div>
                <button onClick={() => setEditingTimes(true)} disabled={!desktop} aria-label={translate("Edit scheduled times")} title={translate("Edit scheduled times")} className="shrink-0 rounded-lg p-2 text-gray-500 hover:bg-gray-100 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800"><ActionIcon name="rename" /></button>
              </div>
            </div>
            </>}
            {section === "updates" && <>
              <div className={rowClassName}>
                <div><label htmlFor="automatic-update-checks" className={labelClassName}>{translate("Automatically check for updates")}</label><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{translate("Checks for new versions. Download and installation require your action.")}</p></div>
                <ToggleSwitch id="automatic-update-checks" label={translate("Automatically check for updates")} checked={preferences.automatic_update_checks} disabled={!ready || savingPreferences || !updater.enabled} onChange={enabled => void change({ automatic_update_checks: enabled })} />
              </div>
              <UpdateSettings updater={updater} automaticChecks={preferences.automatic_update_checks} />
            </>}
          </div>
          {!displaySettings && !error && <p className="py-3 text-sm text-gray-500">{translate("Loading display settings...")}</p>}
          {error && <p role="alert" className="py-3 text-sm text-red-600 dark:text-red-300">{localizeError(error)}</p>}
          {preferencesError && <div role="alert" className="py-3 text-sm text-red-600 dark:text-red-300">{localizeError(preferencesError)} <button className="underline" onClick={() => void runtimePreferences.reload()}>{translate("Retry")}</button></div>}
        </div>
      </div>
      {editingTimes && <TimedWarmupEditor times={timedWarmupTimes} onChange={onTimedWarmupTimesChange} onClose={() => setEditingTimes(false)} />}
    </div>
  );
}
