import { useCallback, useEffect, useRef, useState } from "react";
import { invokeBackend, isTauriRuntime } from "../lib/platform";
import { REFRESH_INTERVALS, type RefreshScope } from "../lib/refreshPolicy";

export interface RuntimePreferences {
  autostart_enabled: boolean | null;
  startup_minimized: boolean;
  automatic_update_checks: boolean;
  refresh_scope: RefreshScope;
  refresh_interval_seconds: number;
}
const defaults: RuntimePreferences = {
  autostart_enabled: null, startup_minimized: true, automatic_update_checks: true,
  refresh_scope: "current", refresh_interval_seconds: 60,
};
const WEB_KEY = "codex-switcher-runtime-preferences";

export function useRuntimePreferences() {
  const [preferences, setPreferences] = useState(defaults);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(preferences);
  const busy = useRef(false);
  const generation = useRef(0);
  const apply = useCallback((value: RuntimePreferences) => {
    current.current = value;
    setPreferences(value);
  }, []);
  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      let value = defaults;
      if (isTauriRuntime()) {
        value = await invokeBackend<RuntimePreferences>("get_runtime_preferences");
      } else {
        try {
          const saved = JSON.parse(localStorage.getItem(WEB_KEY) ?? "{}");
          value = { ...defaults,
            refresh_scope: saved.refresh_scope === "all" ? "all" : "current",
            refresh_interval_seconds: REFRESH_INTERVALS.includes(saved.refresh_interval_seconds) ? saved.refresh_interval_seconds : 60,
          };
        } catch { /* An invalid browser preference falls back to the safe defaults. */ }
      }
      if (request === generation.current) { apply(value); setError(null); setReady(true); }
    } catch (error) {
      if (request === generation.current) setError(String(error));
    }
  }, [apply]);

  useEffect(() => {
    void load();
    if (!isTauriRuntime()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const unlisten = await listen("app-settings-changed", () => { if (!busy.current) void load(); });
      if (disposed) unlisten(); else stop = unlisten;
    }).catch(error => { if (!disposed) setError(String(error)); });
    return () => { disposed = true; generation.current++; stop?.(); };
  }, [load]);

  const change = useCallback(async (patch: Partial<RuntimePreferences>) => {
    if (busy.current) return;
    busy.current = true;
    generation.current++;
    setSaving(true); setError(null);
    try {
      const value = { ...current.current, ...patch };
      if (isTauriRuntime()) apply(await invokeBackend<RuntimePreferences>("set_runtime_preferences", { preferences: value }));
      else { localStorage.setItem(WEB_KEY, JSON.stringify(value)); apply(value); }
    } catch (error) { setError(String(error)); }
    finally { busy.current = false; setSaving(false); }
  }, [apply]);

  return { preferences, ready, saving, error, change, reload: load };
}
export type RuntimePreferencesController = ReturnType<typeof useRuntimePreferences>;
