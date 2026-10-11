import { useCallback, useState } from "react";
import type { CodexProcessInfo } from "../types";
import { invokeBackend } from "../lib/platform";
import { getLocale } from "../lib/i18n";

const msg = (en: string, zh: string) => getLocale() === "zh-CN" ? zh : en;

interface KillCodexProcessesResult {
  targeted_count: number;
  killed_pids: number[];
  failed_pids: number[];
  reopen_token?: string | null;
}

interface UseForceCloseCodexProcessesOptions {
  processCount: number;
  checkProcesses: () => Promise<CodexProcessInfo | null>;
  showToast: (message: string, isError?: boolean) => void;
  formatError: (err: unknown) => string;
}

export function useForceCloseCodexProcesses({
  processCount,
  checkProcesses,
  showToast,
  formatError,
}: UseForceCloseCodexProcessesOptions) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isForceClosing, setIsForceClosing] = useState(false);

  const closeCodexProcesses = useCallback(async (reopenDesktop = false) => {
    try {
      setIsForceClosing(true);

      const result = await invokeBackend<KillCodexProcessesResult>(
        "kill_codex_processes",
        { reopenDesktop, forceClose: true }
      );
      const latestProcessInfo = await checkProcesses();
      const remainingCount = latestProcessInfo?.count ?? processCount;
      const closedCount = Math.max(0, processCount - remainingCount);

      if (!latestProcessInfo) {
        showToast(msg("Could not verify that Codex closed. Switching was cancelled.", "无法确认 Codex 已关闭，已取消切换。"), true);
      } else if (result.failed_pids.length > 0) {
        showToast(msg("Some Codex processes could not be stopped. Switching was cancelled.", "部分 Codex 进程未能关闭，已取消切换。"), true);
        return null;
      } else if (result.targeted_count === 0) {
        showToast(msg("No running Codex processes found.", "没有正在运行的 Codex 进程。"));
      } else if (remainingCount === 0) {
        showToast(
          msg(`Force closed ${processCount} Codex sessions.`, `已强制关闭 ${processCount} 个 Codex 进程。`)
        );
      } else if (closedCount > 0) {
        showToast(
          msg(`Closed ${closedCount}/${processCount} Codex sessions; ${remainingCount} still running.`, `已关闭 ${closedCount}/${processCount} 个 Codex 进程，仍有 ${remainingCount} 个运行，已取消切换。`),
          true
        );
      } else {
        showToast(
          msg(`Could not force close ${remainingCount} Codex sessions.`, `无法强制关闭 ${remainingCount} 个 Codex 进程，已取消切换。`),
          true
        );
      }

      return { processInfo: latestProcessInfo, reopenToken: result.reopen_token ?? null };
    } catch (err) {
      console.error("Failed to close Codex processes:", err);
      showToast(msg(`Close failed: ${formatError(err)}`, `关闭失败：${formatError(err)}`), true);
      return null;
    } finally {
      setConfirmOpen(false);
      setIsForceClosing(false);
    }
  }, [checkProcesses, formatError, processCount, showToast]);

  return {
    forceCloseConfirmOpen: confirmOpen,
    setForceCloseConfirmOpen: setConfirmOpen,
    isForceClosingCodex: isForceClosing,
    closeCodexProcesses,
  };
}
