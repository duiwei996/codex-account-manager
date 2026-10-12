import type { Update } from "@tauri-apps/plugin-updater";
import { installUpdate, type UpdateInstallationStatus } from "./updateInstallation.ts";

export type AppUpdate = Pick<Update, "version" | "body" | "downloadAndInstall" | "close">;
export type AppUpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; update: AppUpdate }
  | UpdateInstallationStatus
  | { kind: "error"; phase: "check" | "install" | "restart"; message: string };

export function createAppUpdater(dependencies: {
  enabled: boolean;
  check: () => Promise<AppUpdate | null>;
  relaunch: () => Promise<void>;
}) {
  let snapshot: { status: AppUpdateStatus; dismissed: boolean } = {
    status: { kind: "idle" }, dismissed: false,
  };
  let busy = false;
  let pendingUpdate: AppUpdate | null = null;
  const listeners = new Set<() => void>();
  const publish = (status: AppUpdateStatus, dismissed = false) => {
    snapshot = { status, dismissed };
    listeners.forEach(listener => listener());
  };
  const release = async (update: AppUpdate | null) => {
    try { await update?.close(); } catch { /* The backend may already have released it. */ }
  };
  const failure = (phase: "check" | "install" | "restart", error: unknown) => {
    publish({ kind: "error", phase, message: error instanceof Error ? error.message : String(error) });
  };

  return {
    enabled: dependencies.enabled,
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dismiss: () => publish(snapshot.status, true),
    async checkForUpdate() {
      if (!dependencies.enabled || busy || snapshot.status.kind === "ready" ||
          (snapshot.status.kind === "error" && snapshot.status.phase === "restart")) return;
      busy = true;
      publish({ kind: "checking" });
      const previous = pendingUpdate;
      pendingUpdate = null;
      try {
        pendingUpdate = await dependencies.check();
        publish(pendingUpdate ? { kind: "available", update: pendingUpdate } : { kind: "current" });
      } catch (error) {
        failure("check", error);
      } finally {
        await release(previous);
        busy = false;
      }
    },
    async downloadAndInstall() {
      if (!dependencies.enabled || busy || snapshot.status.kind !== "available" || !pendingUpdate) return;
      busy = true;
      const update = pendingUpdate;
      try {
        await installUpdate(update, publish);
        pendingUpdate = null;
        await release(update);
      } catch (error) {
        failure("install", error);
      } finally {
        busy = false;
      }
    },
    async restart() {
      if (!dependencies.enabled || busy || (snapshot.status.kind !== "ready" &&
          !(snapshot.status.kind === "error" && snapshot.status.phase === "restart"))) return;
      busy = true;
      try { await dependencies.relaunch(); }
      catch (error) { failure("restart", error); }
      finally { busy = false; }
    },
  };
}
