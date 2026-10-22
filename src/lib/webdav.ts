import { invokeBackend, isTauriRuntime } from "./platform";
import { getLocale, setLocale } from "./i18n";
import { THEME_STORAGE_KEY } from "./theme";
import { AUTO_WARMUP_ALL_STORAGE_KEY, TIMED_WARMUP_ENABLED_STORAGE_KEY, TIMED_WARMUP_TIMES_STORAGE_KEY, normalizeTimedWarmupTimes } from "./autoWarmup";
import { applyAccountSyncCaches, collectAccountSyncCaches, type AccountSyncCache } from "./accountQuotaSync";
import type { AccountInfo } from "../types";

export interface DavConfig {
  server: string; username: string; directory: string;
  sync_accounts: boolean; sync_settings: boolean; auto_sync: boolean;
}
export interface ConfigView { config: DavConfig; password_saved: boolean }
export interface DavDirectory { name: string; path: string }
export type SyncMode = "merge" | "upload" | "download";
export interface SyncChanges { added: string[]; updated: string[]; deleted: string[]; settings: string[]; cache_updated?:string[] }
export interface SyncPreview {
  mode: SyncMode; choice: "local" | "remote" | null; token: string; first_sync: boolean; cloud_missing: boolean;
  local_accounts: number; cloud_accounts: number; to_local: SyncChanges; to_cloud: SyncChanges;
  restored_accounts: string[]; conflicts: { account: string | null; field: string }[];
}
export interface SyncResult { conflicts: string[]; bytes: number; uploaded: boolean; synced_at: string; ui: Record<string, unknown> | null; needs_confirmation: boolean; preview: SyncPreview; recovery_path: string | null; account_caches?:Record<string,AccountSyncCache> | null }
export interface SyncOptions { choice?: "local" | "remote"; mode?: SyncMode; confirmation?: string; automatic?: boolean }
export const defaultDavConfig: DavConfig = { server: "", username: "", directory: "/", sync_accounts: true, sync_settings: true, auto_sync: false };
export const DAV_STATE_EVENT = "webdav-state-changed";
export const DAV_APPLIED_EVENT = "webdav-preferences-applied";
export const davState: { busy: boolean; error: string; result: SyncResult | null; paused: boolean } = { busy: false, error: "", result: null, paused: false };
function notify() { window.dispatchEvent(new Event(DAV_STATE_EVENT)); }
export function collectSyncUi() {
  let times: string[] = [];
  try { const value: unknown = JSON.parse(localStorage.getItem(TIMED_WARMUP_TIMES_STORAGE_KEY) ?? "[]"); if (Array.isArray(value)) times = normalizeTimedWarmupTimes(value.filter((v): v is string => typeof v === "string")); } catch { /* Invalid schedules are not uploaded. */ }
  return {
    theme: localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light",
    language: getLocale(), auto_warmup: localStorage.getItem(AUTO_WARMUP_ALL_STORAGE_KEY) === "true",
    timed_warmup: localStorage.getItem(TIMED_WARMUP_ENABLED_STORAGE_KEY) === "true", warmup_times: times,
  };
}
export function applySyncUi(ui: Record<string, unknown>) {
  if (ui.theme === "dark" || ui.theme === "light") localStorage.setItem(THEME_STORAGE_KEY, ui.theme);
  if (typeof ui.auto_warmup === "boolean") localStorage.setItem(AUTO_WARMUP_ALL_STORAGE_KEY, String(ui.auto_warmup));
  if (typeof ui.timed_warmup === "boolean") localStorage.setItem(TIMED_WARMUP_ENABLED_STORAGE_KEY, String(ui.timed_warmup));
  if (Array.isArray(ui.warmup_times)) localStorage.setItem(TIMED_WARMUP_TIMES_STORAGE_KEY, JSON.stringify(normalizeTimedWarmupTimes(ui.warmup_times)));
  if (ui.language === "zh-CN" || ui.language === "en-US") setLocale(ui.language);
  window.dispatchEvent(new Event(DAV_APPLIED_EVENT));
}
export async function runDavSync(options: SyncOptions = {}) {
  if (davState.busy) return;
  davState.busy = true; davState.error = ""; notify();
  const ui = collectSyncUi();
  try {
    const result = await invokeBackend<SyncResult>("sync_webdav", { ui, accountCaches:collectAccountSyncCaches(), choice: options.choice ?? null, mode: options.mode ?? "merge", confirmation: options.confirmation ?? null, automatic: options.automatic ?? false });
    davState.result = result;
    davState.paused = result.needs_confirmation || result.conflicts.length > 0;
    // Preserve fields edited during the request while still applying independent cloud changes.
    if (!result.needs_confirmation && !result.conflicts.length) {
      if (result.account_caches) applyAccountSyncCaches(await invokeBackend<AccountInfo[]>("list_accounts"),result.account_caches);
      if (result.ui) {
        const current: Record<string, unknown> = collectSyncUi();
        const original: Record<string, unknown> = ui;
        applySyncUi(Object.fromEntries(Object.entries(result.ui).filter(([key]) => JSON.stringify(current[key]) === JSON.stringify(original[key]))));
      }
      window.dispatchEvent(new Event("webdav-sync-completed"));
    }
  } catch (error) {
    davState.error = String(error);
    // Keep automatic sync active; the one-minute timer retries errors.
  } finally { davState.busy = false; notify(); }
}
export function resumeDavSync() { davState.paused = false; davState.error = ""; davState.result = null; notify(); }
export function cancelDavPreview() { davState.result = null; davState.paused = true; notify(); }
export function startDavAutoSync() {
  if (!isTauriRuntime()) return () => {};
  let disposed = false;
  let checking = false;
  const tick = async () => {
    if (disposed || checking || davState.busy || davState.paused) return;
    checking = true;
    try {
      const { config } = await invokeBackend<ConfigView>("get_webdav_config");
      if (!disposed && config.auto_sync && config.server && (config.sync_accounts || config.sync_settings)) await runDavSync({ automatic: true });
    } catch (error) { davState.error = String(error); notify(); }
    finally { checking = false; }
  };
  const initial = window.setTimeout(() => void tick(), 3000);
  const interval = window.setInterval(() => void tick(), 60_000);
  return () => { disposed = true; window.clearTimeout(initial); window.clearInterval(interval); };
}
