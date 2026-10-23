import { useEffect, useState } from "react";
import { useLocale } from "../lib/i18n";
import { invokeBackend, isTauriRuntime } from "../lib/platform";
import { DAV_STATE_EVENT, davState, reportDavNotice, resumeDavSync, runDavSync, type ConfigView } from "../lib/webdav";
import { ActionIcon } from "./ActionIcon";

export function WebDavSyncButton({ onOpenSettings }: { onOpenSettings: () => void }) {
  const locale = useLocale();
  const [sync, setSync] = useState({ ...davState });
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    const update = () => setSync({ ...davState });
    window.addEventListener(DAV_STATE_EVENT, update);
    return () => window.removeEventListener(DAV_STATE_EVENT, update);
  }, []);
  const busy = starting || sync.busy;
  const label = locale === "zh-CN" ? "立即同步" : "Sync now";
  const start = async () => {
    if (starting || davState.busy) return;
    setStarting(true);
    try {
      const { config } = await invokeBackend<ConfigView>("get_webdav_config");
      if (!config.server || (!config.sync_accounts && !config.sync_settings)) {
        onOpenSettings();
        return;
      }
      resumeDavSync();
      await runDavSync();
    } catch { reportDavNotice(locale === "zh-CN" ? "同步失败，无法读取 WebDAV 配置" : "Sync failed: unable to read WebDAV configuration", true); }
    finally { setStarting(false); }
  };
  return <button disabled={!isTauriRuntime() || busy || sync.result?.needs_confirmation === true} onClick={() => void start()}
    title={label} aria-label={label} aria-busy={busy}
    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300">
    <ActionIcon name="sync" spinning={busy} />
  </button>;
}
