import type { AppUpdater } from "../hooks/useAppUpdater";
import { UpdateError } from "./UpdateError";
import { tr, useLocale } from "../lib/i18n";
import { isTauriRuntime } from "../lib/platform";

export function UpdateSettings({ updater }: { updater: AppUpdater }) {
  const locale = useLocale();
  const t = (key: string) => tr(key, locale);
  const { status } = updater;
  const needsRestart = status.kind === "ready" || (status.kind === "error" && status.phase === "restart");
  const busy = status.kind === "checking" || status.kind === "downloading" || status.kind === "installing";

  return (
    <section className="py-3" aria-label={t("App updates")}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{t("Current version")}</p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">v{updater.version}</p>
        </div>
        <button
          onClick={() => void updater.checkForUpdate()}
          disabled={!updater.enabled || busy || needsRestart}
          className="shrink-0 rounded-lg bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          {status.kind === "checking" ? t("Checking for updates...") : t("Check for updates")}
        </button>
      </div>
      {!updater.enabled ? (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {isTauriRuntime() ? t("Automatic updates are unavailable in this build.") : t("Desktop updates are unavailable in the web version.")}
        </p>
      ) : (
        <>
          <div role={status.kind === "error" ? "alert" : "status"} aria-live="polite" className="mt-2 text-sm text-gray-600 dark:text-gray-300">
            {status.kind === "checking" && t("Checking for updates...")}
            {status.kind === "current" && t("You are using the latest version.")}
            {status.kind === "available" && <>
              <p>{t("Update available: v")}{status.update.version}</p>
              {status.update.body && <p className="mt-1 whitespace-pre-wrap text-xs text-gray-500 dark:text-gray-400">{status.update.body}</p>}
              <button onClick={() => void updater.downloadAndInstall()} className="mt-2 rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white dark:bg-gray-100 dark:text-gray-900">{t("Update")}</button>
            </>}
            {status.kind === "downloading" && <>
              <p>{t("Downloading update...")} {status.total && status.total > 0 ? `${Math.min(100, Math.round(status.downloaded / status.total * 100))}%` : `${(status.downloaded / 1024 / 1024).toFixed(1)} MB`}</p>
              <progress aria-label={t("Downloading update...")} max={status.total ?? undefined} value={status.total && status.total > 0 ? Math.min(status.downloaded, status.total) : undefined} className="mt-2 h-2 w-full" />
            </>}
            {status.kind === "installing" && t("Installing update. Complete any system authorization prompt...")}
            {needsRestart && <>
              <p>{t("Update ready. Restart to apply.")}</p>
              <button onClick={() => void updater.restart()} className="mt-2 rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white dark:bg-gray-100 dark:text-gray-900">{t("Restart")}</button>
            </>}
            {status.kind === "error" && <UpdateError phase={status.phase} message={status.message} />}
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{t("Checks automatically at startup and every 6 hours.")}</p>
        </>
      )}
    </section>
  );
}
