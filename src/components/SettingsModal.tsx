import { CenteredSelect } from "./CenteredSelect";
import { localizeError } from "../lib/errors";
import { useCallback, useEffect, useRef, useState } from "react";
import { invokeBackend, isTauriRuntime } from "../lib/platform";
import type { DockDisplayMode } from "../types";
import { setLocale, tr, useLocale } from "../lib/i18n";
import { normalizeTimedWarmupTimes } from "../lib/autoWarmup";
import type { ThemeMode } from "../lib/theme";
import type { AppUpdater } from "../hooks/useAppUpdater";
import { UpdateSettings } from "./UpdateSettings";

type TrayDisplayMode = "icon_and_session" | "active_usage_text" | "hidden";
interface DisplaySettings {
  account_switch_mode: "direct" | "force_close";
  tray_display_mode: TrayDisplayMode;
  dock_display_mode: DockDisplayMode | null;
}

interface SettingsModalProps {
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
  updater,
  theme, onThemeChange,
  autoWarmupEnabled, autoWarmupLabel, onAutoWarmupChange, warmupAvailable,
  timedWarmupEnabled, timedWarmupTimes, timedWarmupLabel,
  onTimedWarmupChange, onTimedWarmupTimesChange,
  onClose,
}: SettingsModalProps) {
  const locale = useLocale();
  const translate = (key: Parameters<typeof tr>[0]) => tr(key, locale);
  const [displaySettings, setDisplaySettings] = useState<DisplaySettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeDraft, setTimeDraft] = useState("");
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
  const rowClassName = "flex items-center justify-between gap-4 py-3";
  const labelClassName = "text-sm font-medium text-gray-900 dark:text-gray-100";
  const addTime = () => {
    const normalized = normalizeTimedWarmupTimes([timeDraft]);
    if (!normalized.length) return;
    onTimedWarmupTimesChange(normalizeTimedWarmupTimes([...timedWarmupTimes, ...normalized]));
    setTimeDraft("");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="settings-title" className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
        <div className="flex shrink-0 items-center justify-between border-b border-gray-100 p-5 dark:border-gray-800">
          <h2 id="settings-title" className="text-lg font-semibold text-gray-900 dark:text-gray-100">{translate("Settings")}</h2>
          <button onClick={onClose} disabled={saving} aria-label={translate("Close")} className="rounded-lg px-2 py-1 text-gray-400 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-800">✕</button>
        </div>
        <div className="overflow-y-auto px-5 py-2">
          <div className="divide-y divide-gray-100 dark:divide-gray-800">
            <UpdateSettings updater={updater} />
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
            {displaySettings && <div>
              <div className={rowClassName}>
                <label htmlFor="account-switch-mode" className={labelClassName}>{translate("Account switching")}</label>
                <CenteredSelect id="account-switch-mode" value={displaySettings.account_switch_mode} disabled={saving} onChange={(event) => void changeDisplaySetting("set_account_switch_mode", event.target.value)} className={selectClassName}>
                  <option value="force_close">{translate("Force close and switch")}</option>
                  <option value="direct">{translate("Switch directly")}</option>
                </CenteredSelect>
              </div>
              <p className="pb-3 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{translate("Force switching closes Codex and reopens it after switching. Direct switching leaves Codex running.")}</p>
            </div>}
            <div>
              <div className={rowClassName}>
                <label htmlFor="auto-warmup" className={labelClassName}>{translate("Auto Warm Up")}</label>
                <CenteredSelect id="auto-warmup" value={autoWarmupEnabled ? "on" : "off"} disabled={!warmupAvailable} onChange={(event) => onAutoWarmupChange(event.target.value === "on")} className={selectClassName}>
                  <option value="off">{translate("off")}</option>
                  <option value="on">{translate("on")}</option>
                </CenteredSelect>
              </div>
              <p className="pb-3 text-xs text-gray-500 dark:text-gray-400">{autoWarmupLabel}</p>
            </div>
            <div>
              <div className={rowClassName}>
                <label htmlFor="timed-warmup" className={labelClassName}>{translate("Timed warm-up")}</label>
                <CenteredSelect id="timed-warmup" value={timedWarmupEnabled ? "on" : "off"} disabled={!desktop} onChange={(event) => onTimedWarmupChange(event.target.value === "on")} className={selectClassName}>
                  <option value="off">{translate("off")}</option>
                  <option value="on">{translate("on")}</option>
                </CenteredSelect>
              </div>
              <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">{timedWarmupLabel}</p>
              <div className="mb-3 flex flex-wrap gap-2">
                {timedWarmupTimes.length === 0 ? <p className="text-xs text-gray-400">{translate("No times added yet.")}</p> : timedWarmupTimes.map(time => (
                  <span key={time} className="inline-flex items-center gap-2 rounded-lg bg-gray-100 px-3 py-1.5 text-sm text-gray-700 dark:bg-gray-800 dark:text-gray-200">
                    <span className="font-mono">{time}</span>
                    <button onClick={() => onTimedWarmupTimesChange(timedWarmupTimes.filter(entry => entry !== time))} disabled={!desktop} aria-label={`${translate("Delete")} ${time}`} className="text-gray-400 hover:text-red-500 disabled:opacity-50">✕</button>
                  </span>
                ))}
              </div>
              <div className="mb-3 flex items-center justify-end gap-2">
                <input type="time" value={timeDraft} disabled={!desktop} aria-label={translate("Timed warm-up")} onChange={event => setTimeDraft(event.target.value)} onKeyDown={event => {if (event.key === "Enter") addTime();}} className="min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" />
                <button onClick={addTime} disabled={!desktop || !timeDraft} className="rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900">{translate("Add")}</button>
              </div>
            </div>
          </div>
          {!displaySettings && !error && <p className="py-3 text-sm text-gray-500">{translate("Loading display settings...")}</p>}
          {error && <p role="alert" className="py-3 text-sm text-red-600 dark:text-red-300">{localizeError(error)}</p>}
        </div>
        <div className="flex shrink-0 justify-end border-t border-gray-100 p-5 dark:border-gray-800">
          <button onClick={onClose} disabled={saving} className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700">{translate("Done")}</button>
        </div>
      </div>
    </div>
  );
}
