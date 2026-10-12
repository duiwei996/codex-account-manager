import { useEffect, useState, useSyncExternalStore } from "react";
import { version } from "../../package.json";
import { createAppUpdater } from "../lib/appUpdater";
import { isTauriRuntime } from "../lib/platform";

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function useAppUpdater() {
  const [controller] = useState(() => createAppUpdater({
    enabled: import.meta.env.VITE_UPDATER_ENABLED === "true" && isTauriRuntime(),
    check: async () => {
      const { check } = await import("@tauri-apps/plugin-updater");
      return check({ timeout: 30_000 });
    },
    relaunch: async () => {
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  }));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  useEffect(() => {
    if (!controller.enabled) return;
    void controller.checkForUpdate();
    const timer = window.setInterval(() => void controller.checkForUpdate(), UPDATE_CHECK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [controller]);

  return { ...controller, ...snapshot, version };
}

export type AppUpdater = ReturnType<typeof useAppUpdater>;
