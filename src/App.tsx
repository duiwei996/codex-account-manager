import { CenteredSelect } from "./components/CenteredSelect";
import { groupAccountsByPlan, selectAccountPanel } from "./lib/accountGroups";
import { selectRefreshAccounts } from "./lib/refreshPolicy";
import { ActionIcon } from "./components/ActionIcon";
import { localizeError } from "./lib/errors";
import { AccountTransferModal } from "./components/AccountTransferModal";
import { isLimitFull, getPreferredUsedPercent, getPreferredResetsAt, getTimedWarmupTargets, matchesAccountSearch } from "./lib/accountDisplay";
import { getLocale, tr, useLocale } from "./lib/i18n";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useAccounts } from "./hooks/useAccounts";
import { SettingsModal } from "./components/SettingsModal";
import { UpdateChecker } from "./components/UpdateChecker";
import { useAppUpdater } from "./hooks/useAppUpdater";
import { useRuntimePreferences } from "./hooks/useRuntimePreferences";
import { finishForceClose } from "./lib/desktopReopen";
import { useForceCloseCodexProcesses } from "./hooks/useForceCloseCodexProcesses";
import { AccountCard, AddAccountModal, WindowResizeBorders } from "./components";
import type { AccountWithUsage, CodexProcessInfo, DockDisplayMode, UsageInfo } from "./types";
import {
  isTauriRuntime,
  invokeBackend,
} from "./lib/platform";
import {
  applyTheme,
  readStoredTheme,
  THEME_CHANGED_EVENT,
  THEME_STORAGE_KEY,
  type ThemeMode,
} from "./lib/theme";
import {
  AUTO_WARMUP_ACCOUNTS_STORAGE_KEY,
  AUTO_WARMUP_ALL_CHANGED_EVENT,
  AUTO_WARMUP_LEDGER_STORAGE_KEY,
  TIMED_WARMUP_LEDGER_STORAGE_KEY,
  normalizeTimedWarmupTimes,
  readAutoWarmupAllEnabled,
  readTimedWarmupEnabled,
  readTimedWarmupTimes,
  writeAutoWarmupAllEnabled,
  writeTimedWarmupEnabled,
  writeTimedWarmupTimes,
} from "./lib/autoWarmup";
import {
  getAutoWarmupWindowKey,
  getAutoWarmupWindowKind,
  getDueAutoWarmupWindow,
  type AutoWarmupWindow,
  type AutoWarmupWindowKind,
} from "./lib/autoWarmupPolicy";
import { getTauriWindow } from "./lib/tauriWindow";
import "./App.css";

const AUTO_WARMUP_CHECK_INTERVAL_MS = 30 * 1000;
const AUTO_WARMUP_RETRY_BACKOFF_MS = 60 * 1000;
const ACCOUNT_SEARCH_THRESHOLD = 1;
const SWITCH_ACCOUNT_BLOCKED_EVENT = "switch-account-blocked";
const CLOSE_BEHAVIOR_REQUESTED_EVENT = "close-behavior-requested";
interface SwitchAccountBlockedPayload {
  accountId?: string;
  error?: string;
}
interface CloseBehaviorRequestedPayload {
  requestId?: number;
}
type AutoWarmupLedger = Record<
  string,
  {
    lastSuccessfulWarmupAt?: number;
    lastAutoWindowKey?: string;
    lastAutoWindowKind?: AutoWarmupWindowKind;
  }
>;
const isMacOs =
  typeof navigator !== "undefined" &&
  /(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent);

function readStoredStringArray(key: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function readStoredAutoWarmupLedger(): AutoWarmupLedger {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(AUTO_WARMUP_LEDGER_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const entries: Array<[string, AutoWarmupLedger[string]]> = [];
    for (const [accountId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;

      const entry: AutoWarmupLedger[string] = {};
      if (
        "lastSuccessfulWarmupAt" in value &&
        typeof value.lastSuccessfulWarmupAt === "number"
      ) {
        entry.lastSuccessfulWarmupAt = value.lastSuccessfulWarmupAt;
      }
      if ("lastAutoWindowKey" in value && typeof value.lastAutoWindowKey === "string") {
        entry.lastAutoWindowKey = value.lastAutoWindowKey;
      }
      if (
        "lastAutoWindowKind" in value &&
        (value.lastAutoWindowKind === "session" || value.lastAutoWindowKind === "weekly")
      ) {
        entry.lastAutoWindowKind = value.lastAutoWindowKind;
      }

      if (Object.keys(entry).length > 0) entries.push([accountId, entry]);
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function readStoredTimedWarmupLedger(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(TIMED_WARMUP_LEDGER_STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string"
      )
    );
  } catch {
    return {};
  }
}

function App() {
  const locale = useLocale();
  const runtimePreferences = useRuntimePreferences();
  const updater = useAppUpdater(runtimePreferences.ready && runtimePreferences.preferences.automatic_update_checks);
  const [webReadOnly, setWebReadOnly] = useState(!isTauriRuntime());
  useEffect(() => {
    document.documentElement.lang = locale;
    if (isTauriRuntime()) return;
    void invokeBackend<{ readOnly: boolean }>("web_capabilities").then(result => setWebReadOnly(result.readOnly)).catch(() => {});
  }, [locale]);
  const t = (text: string) => tr(text, locale);
  const msg = (en: string, zh: string) => getLocale() === "zh-CN" ? zh : en;
  useEffect(() => {
    if (!isTauriRuntime()) return;
    void invokeBackend("set_ui_language", { locale }).catch((error) => {
      console.error("Failed to sync native menu language:", error);
    });
  }, [locale]);
  const {
    accounts,
    listReady,
    loading,
    error,
    loadAccounts,
    refreshUsage,
    refreshSingleUsage,
    warmupAccount,
    switchAccount,
    deleteAccount,
    renameAccount,
    startOAuthLogin,
    completeOAuthLogin,
    cancelOAuthLogin,
    loadMaskedAccountIds,
    saveMaskedAccountIds,
  } = useAccounts(runtimePreferences.preferences, runtimePreferences.ready);

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [reloginAccount, setReloginAccount] = useState<AccountWithUsage | null>(null);
  const handleRelogin = (account: AccountWithUsage) => { setReloginAccount(account); setIsAddModalOpen(true); };
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [transferMode, setTransferMode] = useState<"export" | "import">("export");
  const [exportAccountId, setExportAccountId] = useState<string | null>(null);
  const openTransfer = (mode: "export" | "import", id: string | null = null) => {setTransferMode(mode);setExportAccountId(id);setIsConfigModalOpen(true);};
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [processInfo, setProcessInfo] = useState<CodexProcessInfo | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isOpeningCodex, setIsOpeningCodex] = useState(false);
  const [warmingUpId, setWarmingUpId] = useState<string | null>(null);
  const [refreshSuccess, setRefreshSuccess] = useState(false);
  const [warmupToast, setWarmupToast] = useState<{
    message: string;
    isError: boolean;
  } | null>(null);
  const [autoWarmupAllEnabled, setAutoWarmupAllEnabled] = useState(() => {
    return readAutoWarmupAllEnabled();
  });
  const [autoWarmupAccountIds, setAutoWarmupAccountIds] = useState<Set<string>>(
    () => new Set(readStoredStringArray(AUTO_WARMUP_ACCOUNTS_STORAGE_KEY))
  );
  const [autoWarmupLedger, setAutoWarmupLedger] =
    useState<AutoWarmupLedger>(() => readStoredAutoWarmupLedger());
  const [autoWarmupRunningIds, setAutoWarmupRunningIds] = useState<Set<string>>(
    new Set()
  );
  const [timedWarmupEnabled, setTimedWarmupEnabled] = useState(() =>
    readTimedWarmupEnabled()
  );
  const [timedWarmupTimes, setTimedWarmupTimes] = useState<string[]>(() =>
    readTimedWarmupTimes()
  );
  const [timedWarmupRunning, setTimedWarmupRunning] = useState(false);
  const [maskedAccounts, setMaskedAccounts] = useState<Set<string>>(new Set());
  const [accountSearchQuery, setAccountSearchQuery] = useState("");
  const isAccountSearchEnabled = accounts.length >= ACCOUNT_SEARCH_THRESHOLD;
  const [otherAccountsSort, setOtherAccountsSort] = useState<
    | "deadline_asc"
    | "deadline_desc"
    | "remaining_desc"
    | "remaining_asc"
    | "subscription_asc"
    | "subscription_desc"
  >("deadline_asc");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isCompletingForceClose, setIsCompletingForceClose] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forceCloseInFlightRef = useRef(false);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const stop = await listen("desktop-reopen-settings-requested", () => {
        setIsSettingsOpen(true);
      });
      if (disposed) stop();
      else unlisten = stop;
    }).catch((err) => console.error("Failed to listen for settings requests:", err));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const [themeMode, setThemeMode] = useState<ThemeMode>(readStoredTheme);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [closeBehaviorPromptOpen, setCloseBehaviorPromptOpen] = useState(false);
  const [closeBehaviorDontAskAgain, setCloseBehaviorDontAskAgain] = useState(false);
  const [isCompletingCloseBehavior, setIsCompletingCloseBehavior] = useState(false);
  const accountsRef = useRef(accounts);
  const selectedPlanTabRef = useRef(runtimePreferences.preferences.selected_plan_tab);
  selectedPlanTabRef.current = runtimePreferences.preferences.selected_plan_tab;
  const getCategoryTargets = useCallback(() =>
    selectRefreshAccounts(accountsRef.current, "category", selectedPlanTabRef.current), []);
  const isCategoryTarget = useCallback((accountId: string) =>
    getCategoryTargets().some(account => account.id === accountId), [getCategoryTargets]);
  const autoWarmupAccountIdsRef = useRef(autoWarmupAccountIds);
  const autoWarmupLedgerRef = useRef(autoWarmupLedger);
  const autoWarmupRunningIdsRef = useRef(autoWarmupRunningIds);
  const autoWarmupRetryAfterRef = useRef<Record<string, number>>({});
  const timedWarmupRunningRef = useRef(timedWarmupRunning);
  // Tracks the last calendar date (YYYY-MM-DD) each scheduled time fired on,
  // so each time triggers at most once per day.
  const timedWarmupLastFireRef = useRef<Record<string, string>>(readStoredTimedWarmupLedger());

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  useEffect(() => {
    if (!isAccountSearchEnabled && accountSearchQuery) {
      setAccountSearchQuery("");
    }
  }, [accountSearchQuery, isAccountSearchEnabled]);

  useEffect(() => {
    autoWarmupAccountIdsRef.current = autoWarmupAccountIds;
  }, [autoWarmupAccountIds]);

  useEffect(() => {
    autoWarmupRunningIdsRef.current = autoWarmupRunningIds;
  }, [autoWarmupRunningIds]);

  useEffect(() => {
    timedWarmupRunningRef.current = timedWarmupRunning;
  }, [timedWarmupRunning]);

  useEffect(() => {
    try {
      writeTimedWarmupEnabled(timedWarmupEnabled);
    } catch {
      // Ignore storage errors; timed warm-up still works for the current session.
    }
  }, [timedWarmupEnabled]);

  useEffect(() => {
    try {
      writeTimedWarmupTimes(timedWarmupTimes);
    } catch {
      // Ignore storage errors; timed warm-up still works for the current session.
    }
  }, [timedWarmupTimes]);

  useEffect(() => {
    if (loading || error) return;

    const validAccountIds = new Set(accounts.map((account) => account.id));

    setAutoWarmupAccountIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => validAccountIds.has(id)));
      return next.size === prev.size ? prev : next;
    });

    setAutoWarmupLedger((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([accountId]) => validAccountIds.has(accountId))
      );
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });

    for (const accountId of Object.keys(autoWarmupRetryAfterRef.current)) {
      if (!validAccountIds.has(accountId)) {
        delete autoWarmupRetryAfterRef.current[accountId];
      }
    }
  }, [accounts, error, loading]);

  useEffect(() => {
    autoWarmupLedgerRef.current = autoWarmupLedger;
    try {
      window.localStorage.setItem(
        AUTO_WARMUP_LEDGER_STORAGE_KEY,
        JSON.stringify(autoWarmupLedger)
      );
    } catch {
      // Ignore storage errors; auto warm-up still works for the current session.
    }
  }, [autoWarmupLedger]);

  useEffect(() => {
    try {
      writeAutoWarmupAllEnabled(autoWarmupAllEnabled);
    } catch {
      // Ignore storage errors; auto warm-up still works for the current session.
    }

    if (isTauriRuntime()) {
      void import("@tauri-apps/api/event")
        .then(({ emit }) => emit(AUTO_WARMUP_ALL_CHANGED_EVENT, autoWarmupAllEnabled))
        .catch((err) => console.error("Failed to sync tray auto warm-up:", err));
    }
  }, [autoWarmupAllEnabled]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        AUTO_WARMUP_ACCOUNTS_STORAGE_KEY,
        JSON.stringify(Array.from(autoWarmupAccountIds))
      );
    } catch {
      // Ignore storage errors; auto warm-up still works for the current session.
    }
  }, [autoWarmupAccountIds]);

  const handleTitlebarDrag = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!isTauriRuntime() || event.button !== 0) return;
      void getTauriWindow()?.startDragging();
    },
    []
  );

  const handleTitlebarDoubleClick = useCallback(() => {
    if (!isTauriRuntime()) return;
    void getTauriWindow()?.toggleMaximize();
  }, []);

  const toggleMask = (accountId: string) => {
    setMaskedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      void saveMaskedAccountIds(Array.from(next));
      return next;
    });
  };

  const allMasked =
    accounts.length > 0 && accounts.every((account) => maskedAccounts.has(account.id));

  const toggleMaskAll = () => {
    setMaskedAccounts((prev) => {
      const shouldMaskAll = !accounts.every((account) => prev.has(account.id));
      const next = shouldMaskAll ? new Set(accounts.map((account) => account.id)) : new Set<string>();
      void saveMaskedAccountIds(Array.from(next));
      return next;
    });
  };

  const checkProcesses = useCallback(async () => {
    try {
      const info = await invokeBackend<CodexProcessInfo>("check_codex_processes");
      setProcessInfo((prev) => {
        if (
          prev &&
          prev.can_switch === info.can_switch &&
          prev.count === info.count &&
          prev.background_count === info.background_count &&
          prev.pids.length === info.pids.length &&
          prev.pids.every((pid, index) => pid === info.pids[index])
        ) {
          return prev;
        }
        return info;
      });
      return info;
    } catch (err) {
      console.error("Failed to check processes:", err);
      return null;
    }
  }, []);

  // Check processes on mount and periodically
  useEffect(() => {
    if (!isTauriRuntime()) return;
    checkProcesses();
    const interval = setInterval(checkProcesses, 5000);
    return () => clearInterval(interval);
  }, [checkProcesses]);

  // Load masked accounts from storage on mount
  useEffect(() => {
    loadMaskedAccountIds().then((ids) => {
      if (ids.length > 0) {
        setMaskedAccounts(new Set(ids));
      }
    });
  }, [loadMaskedAccountIds]);


  useEffect(() => {
    applyTheme(themeMode);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    } catch {
      // Ignore storage errors; theme still works for current session.
    }

    if (isTauriRuntime()) {
      void import("@tauri-apps/api/event")
        .then(({ emit }) => emit(THEME_CHANGED_EVENT, themeMode))
        .catch((err) => console.error("Failed to sync tray theme:", err));
    }
  }, [themeMode]);

  useEffect(() => {
    if (!isTauriRuntime() || isMacOs) return;

    const appWindow = getTauriWindow();
    if (!appWindow) return;

    let unlisten: (() => void) | undefined;

    const syncMaximizedState = async () => {
      try {
        setIsWindowMaximized(await appWindow.isMaximized());
      } catch (err) {
        console.error("Failed to read window state:", err);
      }
    };

    void syncMaximizedState();

    appWindow
      .onResized(() => {
        void syncMaximizedState();
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => {
        console.error("Failed to watch window resize:", err);
      });

    return () => {
      unlisten?.();
    };
  }, []);

  const handleSwitch = async (accountId: string, restart = false) => {
    if (forceCloseInFlightRef.current) return;
    forceCloseInFlightRef.current = true;
    setSwitchingId(accountId);
    try {
      await switchAccount(accountId, false, restart);
    } catch (err) {
      await loadAccounts(true);
      showWarmupToast(restart
        ? msg(`Restart failed: ${formatWarmupError(err)}`, `重启 Codex 失败：${formatWarmupError(err)}`)
        : msg(`Switch failed: ${formatWarmupError(err)}`, `切换账号失败：${formatWarmupError(err)}`), true);
    } finally {
      setSwitchingId(null);
      forceCloseInFlightRef.current = false;
      void checkProcesses();
    }
  };

  const handleDelete = async (accountId: string) => {
    if (deleteConfirmId !== accountId) {
      setDeleteConfirmId(accountId);
      setTimeout(() => setDeleteConfirmId(null), 3000);
      return;
    }

    try {
      await deleteAccount(accountId);
      setDeleteConfirmId(null);
    } catch (err) {
      console.error("Failed to delete account:", err);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setRefreshSuccess(false);
    try {
      const results = await refreshUsage(getCategoryTargets(), { refreshMetadata: true });
      const failures = results?.filter(usage => usage.error).length ?? 0;
      if (failures) {showWarmupToast(msg(`${failures} accounts could not refresh. Check the account messages.`, `${failures} 个账号刷新失败，请查看账号卡片中的提示。`), true);return;}
      setRefreshSuccess(true);
      setTimeout(() => setRefreshSuccess(false), 2000);
    } finally {
      setIsRefreshing(false);
    }
  };

  const showWarmupToast = useCallback((message: string, isError = false) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setWarmupToast({ message, isError });
    toastTimerRef.current = setTimeout(() => setWarmupToast(null), isError ? 10000 : 2500);
  }, []);

  const formatWarmupError = useCallback((err: unknown) => {
    if (!err) return t("Unknown error");
    if (err instanceof Error && err.message) return localizeError(err);
    if (typeof err === "string") return localizeError(err);
    try {
      return localizeError(JSON.stringify(err));
    } catch {
      return t("Unknown error");
    }
  }, []);

  const markSuccessfulWarmup = useCallback(
    (accountId: string, timestamp = Date.now(), window?: AutoWarmupWindow) => {
      delete autoWarmupRetryAfterRef.current[accountId];
      const next = {
        ...autoWarmupLedgerRef.current,
        [accountId]: {
          ...autoWarmupLedgerRef.current[accountId],
          lastSuccessfulWarmupAt: timestamp,
          ...(window ? { lastAutoWindowKey: getAutoWarmupWindowKey(window), lastAutoWindowKind: window.kind } : {}),
        },
      };
      autoWarmupLedgerRef.current = next;
      setAutoWarmupLedger(next);
    },
    []
  );

  const {
    forceCloseConfirmOpen,
    setForceCloseConfirmOpen,
    isForceClosingCodex: isKillingCodex,
    closeCodexProcesses,
  } = useForceCloseCodexProcesses({
    processCount: processInfo?.count ?? 0,
    checkProcesses,
    showToast: showWarmupToast,
    formatError: formatWarmupError,
  });
  const isForceClosingCodex = isKillingCodex || isCompletingForceClose;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlistenAutoWarmup: (() => void) | undefined;
    let unlistenCloseBehavior: (() => void) | undefined;

    void (async () => {
      if (!isTauriRuntime()) return;
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<SwitchAccountBlockedPayload>(
        SWITCH_ACCOUNT_BLOCKED_EVENT,
        (event) => {
          showWarmupToast(event.payload?.error || t("Account switch was blocked."), true);
          void loadAccounts(true);
        }
      );
      unlistenAutoWarmup = await listen<boolean>(
        AUTO_WARMUP_ALL_CHANGED_EVENT,
        ({ payload }) => {
          if (typeof payload === "boolean") {
            setAutoWarmupAllEnabled(payload);
          }
        }
      );
      unlistenCloseBehavior = await listen<CloseBehaviorRequestedPayload>(
        CLOSE_BEHAVIOR_REQUESTED_EVENT,
        ({ payload }) => {
          const requestId = payload?.requestId;
          if (typeof requestId === "number") {
            void invokeBackend("ack_close_behavior_prompt", { requestId });
          }
          setCloseBehaviorDontAskAgain(false);
          setCloseBehaviorPromptOpen(true);
        }
      );
    })();

    return () => {
      unlisten?.();
      unlistenAutoWarmup?.();
      unlistenCloseBehavior?.();
    };
  }, [checkProcesses, formatWarmupError, setForceCloseConfirmOpen, showWarmupToast, switchAccount]);

  const handleCloseBehaviorChoice = useCallback(
    async (mode: DockDisplayMode) => {
      try {
        setIsCompletingCloseBehavior(true);
        await invokeBackend("complete_close_behavior", {
          mode,
          dontAskAgain: closeBehaviorDontAskAgain,
        });
        setCloseBehaviorPromptOpen(false);
      } catch (err) {
        console.error("Failed to complete close behavior:", err);
        showWarmupToast(msg(`Close failed: ${formatWarmupError(err)}`, `关闭失败：${formatWarmupError(err)}`), true);
      } finally {
        setIsCompletingCloseBehavior(false);
      }
    },
    [closeBehaviorDontAskAgain, formatWarmupError, showWarmupToast]
  );

  const handleForceCloseConfirm = async () => {
    if (forceCloseInFlightRef.current) return;
    forceCloseInFlightRef.current = true;
    setIsCompletingForceClose(true);
    try {
      const result = await closeCodexProcesses(true);
      if (!result?.processInfo?.can_switch) return;

      await finishForceClose(
        { canSwitch: true, reopenToken: result.reopenToken },
        null,
        async (token) => {
          try {
            await invokeBackend("reopen_closed_codex_desktop", { token });
            showWarmupToast(t("Codex desktop reopened."));
          } catch (err) {
            showWarmupToast(msg(`Codex closed, but reopening failed: ${formatWarmupError(err)}`, `Codex 已关闭，但重新打开失败：${formatWarmupError(err)}`), true);
          }
        },
      );
    } catch (err) {
      console.error("Failed to switch account after closing Codex:", err);
      showWarmupToast(msg(`Switch failed after closing Codex: ${formatWarmupError(err)}`, `关闭 Codex 后切换账号失败：${formatWarmupError(err)}`), true);
    } finally {
      setSwitchingId(null);
      setIsCompletingForceClose(false);
      forceCloseInFlightRef.current = false;
      void checkProcesses();
    }
  };

  const handleWarmupAccount = async (accountId: string, accountName: string) => {
    try {
      setWarmingUpId(accountId);
      await warmupAccount(accountId);
      markSuccessfulWarmup(accountId);
      showWarmupToast(msg(`Warm-up sent for ${accountName}`, `已为 ${accountName} 发送预热请求`));
    } catch (err) {
      console.error("Failed to warm up account:", err);
      showWarmupToast(
        msg(`Warm-up failed for ${accountName}: ${formatWarmupError(err)}`, `账号 ${accountName} 预热失败：${formatWarmupError(err)}`),
        true
      );
    } finally {
      setWarmingUpId(null);
    }
  };

  const toggleAutoWarmupAccount = (accountId: string) => {
    setAutoWarmupAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  const getDueAutoWarmupForAccount = useCallback(
    (accountId: string, usage: UsageInfo | undefined) => {
      return getDueAutoWarmupWindow(usage, autoWarmupLedgerRef.current[accountId]);
    },
    []
  );

  const formatWindowDuration = (minutes: number | null | undefined): string => {
    if (!minutes || minutes <= 0) return "";
    if (minutes < 24 * 60) {
      return msg(`${Math.ceil(minutes / 60)}h`, `${Math.ceil(minutes / 60)} 小时`);
    }
    return msg(`${Math.ceil(minutes / (24 * 60))}d`, `${Math.ceil(minutes / (24 * 60))} 天`);
  };

  const getAutoWarmupLabel = useCallback(
    (
      usage: UsageInfo | undefined,
      isEnabled: boolean,
      isRunning: boolean
    ) => {
      if (isRunning) return t("Warming...");
      if (!isEnabled) return t("off");
      if (!usage || usage.error) return t("on");

      const windowKind = getAutoWarmupWindowKind(usage);
      if (windowKind === "session" && isLimitFull(usage.secondary_used_percent)) {
        const weeklyDuration = formatWindowDuration(usage.secondary_window_minutes);
        return weeklyDuration ? `${t("Waiting")} ${weeklyDuration}` : t("Waiting reset");
      }
      if (windowKind === "session") {
        return formatWindowDuration(usage.primary_window_minutes) || msg("5h", "5 小时");
      }
      if (windowKind === "weekly") {
        return formatWindowDuration(usage.secondary_window_minutes) || msg("7d", "7 天");
      }

      return t("on");
    },
    [locale]
  );

  const headerAutoWarmupLabel = useMemo(() => {
    if (autoWarmupRunningIds.size > 0) return t("Auto warming...");
    return autoWarmupAllEnabled || autoWarmupAccountIds.size > 0
      ? t("Auto: on")
      : t("Auto: off");
  }, [autoWarmupAccountIds.size, autoWarmupAllEnabled, autoWarmupRunningIds, locale]);

  const backOffAutoWarmupRetry = useCallback((accountId: string) => {
    autoWarmupRetryAfterRef.current[accountId] =
      Date.now() + AUTO_WARMUP_RETRY_BACKOFF_MS;
  }, []);

  const runAutoWarmupForAccount = useCallback(
    async (accountId: string, accountName: string) => {
      if (!isCategoryTarget(accountId)) return;
      if (autoWarmupRunningIdsRef.current.has(accountId)) return;
      autoWarmupRunningIdsRef.current.add(accountId);
      setAutoWarmupRunningIds((prev) => new Set(prev).add(accountId));

      try {
        let freshUsage: UsageInfo;
        try {
          freshUsage = await refreshSingleUsage(accountId);
        } catch (err) {
          console.error("Auto warm-up usage refresh failed:", err);
          backOffAutoWarmupRetry(accountId);
          return;
        }

        if (!isCategoryTarget(accountId)) return;
        const window = getDueAutoWarmupForAccount(accountId, freshUsage);
        if (!window) return;

        await warmupAccount(accountId);
        markSuccessfulWarmup(accountId, Date.now(), window);
        const modeLabel = window.kind === "session" ? "5h" : "weekly";
        showWarmupToast(msg(`Auto ${modeLabel} warm-up sent for ${accountName}`, `已为 ${accountName} 自动发送 ${modeLabel === "5h" ? "5 小时" : "每周"}预热请求`));
      } catch (err) {
        console.error("Auto warm-up failed:", err);
        backOffAutoWarmupRetry(accountId);
        showWarmupToast(
          msg(`Auto warm-up failed for ${accountName}: ${formatWarmupError(err)}`, `账号 ${accountName} 自动预热失败：${formatWarmupError(err)}`),
          true
        );
      } finally {
        autoWarmupRunningIdsRef.current.delete(accountId);
        setAutoWarmupRunningIds((prev) => {
          const next = new Set(prev);
          next.delete(accountId);
          return next;
        });
      }
    },
    [
      backOffAutoWarmupRetry,
      formatWarmupError,
      getDueAutoWarmupForAccount,
      isCategoryTarget,
      markSuccessfulWarmup,
      refreshSingleUsage,
      showWarmupToast,
      warmupAccount,
    ]
  );

  useEffect(() => {
    if (!isTauriRuntime() || !runtimePreferences.ready || !listReady || (!autoWarmupAllEnabled && autoWarmupAccountIds.size === 0)) return;

    const checkAutoWarmup = () => {
      for (const account of getCategoryTargets()) {
        const autoEnabled =
          autoWarmupAllEnabled || autoWarmupAccountIdsRef.current.has(account.id);
        if (!autoEnabled || autoWarmupRunningIdsRef.current.has(account.id)) continue;

        const retryAfter = autoWarmupRetryAfterRef.current[account.id];
        if (retryAfter && Date.now() < retryAfter) continue;

        if (account.usage && !account.usage.from_cache && !getDueAutoWarmupForAccount(account.id, account.usage)) continue;

        void runAutoWarmupForAccount(account.id, account.name);
      }
    };

    checkAutoWarmup();
    const interval = window.setInterval(
      checkAutoWarmup,
      AUTO_WARMUP_CHECK_INTERVAL_MS
    );

    return () => window.clearInterval(interval);
  }, [
    autoWarmupAccountIds.size,
    autoWarmupAllEnabled,
    runtimePreferences.ready,
    runtimePreferences.preferences.selected_plan_tab,
    listReady,
    getCategoryTargets,
    getDueAutoWarmupForAccount,
    runAutoWarmupForAccount,
  ]);

  const runTimedWarmup = useCallback(async () => {
    if (timedWarmupRunningRef.current) return;
    const targets = getCategoryTargets().filter(account => account.auth_mode === "chat_g_p_t");
    if (targets.length === 0) return;
    timedWarmupRunningRef.current = true;
    setTimedWarmupRunning(true);
    try {
      let warmed = 0;
      let failed = 0;
      for (const account of targets) {
        if (!isCategoryTarget(account.id)) continue;
        const lastSuccess = autoWarmupLedgerRef.current[account.id]?.lastSuccessfulWarmupAt;
        if (autoWarmupRunningIdsRef.current.has(account.id) || (lastSuccess && Date.now() - lastSuccess < 60_000)) continue;
        try {
          const freshUsage = await refreshSingleUsage(account.id);
          if (!isCategoryTarget(account.id)) continue;
          if (!getTimedWarmupTargets([{ ...account, usage: freshUsage, usageLoading: false }]).length) continue;
          const refreshedSuccess = autoWarmupLedgerRef.current[account.id]?.lastSuccessfulWarmupAt;
          if (autoWarmupRunningIdsRef.current.has(account.id) || (refreshedSuccess && Date.now() - refreshedSuccess < 60_000)) continue;
          await warmupAccount(account.id);
          markSuccessfulWarmup(account.id, Date.now());
          warmed += 1;
        } catch (err) {
          console.error("Timed warm-up failed:", err);
          failed += 1;
        }
      }

      if (warmed === 0 && failed === 0) return;
      if (failed === 0) {
        showWarmupToast(
          msg(`Timed warm-up sent for ${warmed} account${warmed === 1 ? "" : "s"}`, `已为 ${warmed} 个账号发送定时预热请求`)
        );
      } else {
        showWarmupToast(msg(`Timed warm-up: ${warmed} ok, ${failed} failed`, `定时预热：成功 ${warmed} 个，失败 ${failed} 个`), true);
      }
    } finally {
      timedWarmupRunningRef.current = false;
      setTimedWarmupRunning(false);
    }
  }, [getCategoryTargets, isCategoryTarget, markSuccessfulWarmup, refreshSingleUsage, showWarmupToast, warmupAccount]);

  useEffect(() => {
    if (!isTauriRuntime() || !runtimePreferences.ready || !listReady || !timedWarmupEnabled || timedWarmupTimes.length === 0) return;

    const checkTimedWarmup = () => {
      if (timedWarmupRunningRef.current) return;

      const now = new Date();
      const todayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
      const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(
        now.getMinutes()
      ).padStart(2, "0")}`;

      // Only fire during the scheduled minute itself; a missed time (e.g. while
      // asleep) is skipped rather than warmed late at the wrong moment.
      if (!timedWarmupTimes.includes(currentTime)) return;
      if (timedWarmupLastFireRef.current[currentTime] === todayKey) return;
      if (!getCategoryTargets().some(account => account.auth_mode === "chat_g_p_t")) return;

      // Mark before running so a slow warm-up can't double-fire on the next tick.
      timedWarmupLastFireRef.current[currentTime] = todayKey;
      try {
        window.localStorage.setItem(
          TIMED_WARMUP_LEDGER_STORAGE_KEY,
          JSON.stringify(timedWarmupLastFireRef.current)
        );
      } catch {
        // Ignore storage errors; timed warm-up still works for the current session.
      }
      void runTimedWarmup();
    };

    checkTimedWarmup();
    const interval = window.setInterval(
      checkTimedWarmup,
      AUTO_WARMUP_CHECK_INTERVAL_MS
    );

    return () => window.clearInterval(interval);
  }, [
    timedWarmupEnabled,
    timedWarmupTimes,
    runtimePreferences.ready,
    runtimePreferences.preferences.selected_plan_tab,
    listReady,
    getCategoryTargets,
    accounts.length,
    runTimedWarmup,
  ]);

  const timedWarmupLabel = useMemo(() => {
    if (timedWarmupRunning) return t("Timed warming...");
    if (!isTauriRuntime() || !timedWarmupEnabled || timedWarmupTimes.length === 0) return t("Timed: off");

    const now = new Date();
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const upcoming = timedWarmupTimes.find((time) => {
      const [hours, minutes] = time.split(":").map(Number);
      return hours * 60 + minutes > nowMinutes;
    });
    return `${t("Timed")}: ${upcoming ?? timedWarmupTimes[0]}`;
  }, [timedWarmupEnabled, timedWarmupRunning, timedWarmupTimes, locale]);

  const handleOpenCodexApp = async () => {
    try {
      setIsOpeningCodex(true);
      await invokeBackend("open_codex_app");
      showWarmupToast(t("Codex app opened."));
      setTimeout(() => {
        void checkProcesses();
      }, 1500);
    } catch (err) {
      console.error("Failed to open Codex app:", err);
      showWarmupToast(msg(`Open Codex failed: ${formatWarmupError(err)}`, `无法打开 Codex：${formatWarmupError(err)}`), true);
    } finally {
      setIsOpeningCodex(false);
    }
  };

  const hasRunningProcesses = processInfo && processInfo.count > 0;
  const sortedAccounts = useMemo(() => {
    const getResetDeadline = (resetAt: number | null | undefined) =>
      resetAt ?? Number.POSITIVE_INFINITY;

    const getSubscriptionDeadline = (expiresAt: string | null | undefined) => {
      if (!expiresAt) return null;
      const timestamp = new Date(expiresAt).getTime();
      return Number.isNaN(timestamp) ? null : timestamp;
    };

    const compareOptionalNumber = (
      aValue: number | null,
      bValue: number | null,
      direction: "asc" | "desc"
    ) => {
      if (aValue === null && bValue === null) return 0;
      if (aValue === null) return 1;
      if (bValue === null) return -1;
      return direction === "asc" ? aValue - bValue : bValue - aValue;
    };

    const getRemainingPercent = (usedPercent: number | null | undefined) => {
      if (usedPercent === null || usedPercent === undefined) {
        return Number.NEGATIVE_INFINITY;
      }
      return Math.max(0, 100 - usedPercent);
    };

    return [...accounts].sort((a, b) => {
      const invalidDiff = Number(!!a.credentials_invalid) - Number(!!b.credentials_invalid);
      if (invalidDiff) return invalidDiff;
      const activeDiff = Number(b.is_active) - Number(a.is_active);
      if (activeDiff) return activeDiff;
      if (
        otherAccountsSort === "subscription_asc" ||
        otherAccountsSort === "subscription_desc"
      ) {
        const subscriptionDiff = compareOptionalNumber(
          getSubscriptionDeadline(a.subscription_expires_at),
          getSubscriptionDeadline(b.subscription_expires_at),
          otherAccountsSort === "subscription_asc" ? "asc" : "desc"
        );
        if (subscriptionDiff !== 0) return subscriptionDiff;

        const deadlineDiff =
          getResetDeadline(getPreferredResetsAt(a.usage)) -
          getResetDeadline(getPreferredResetsAt(b.usage));
        if (deadlineDiff !== 0) return deadlineDiff;

        const remainingDiff =
          getRemainingPercent(getPreferredUsedPercent(b.usage)) -
          getRemainingPercent(getPreferredUsedPercent(a.usage));
        if (remainingDiff !== 0) return remainingDiff;

        return a.name.localeCompare(b.name);
      }

      if (otherAccountsSort === "deadline_asc" || otherAccountsSort === "deadline_desc") {
        const deadlineDiff =
          getResetDeadline(getPreferredResetsAt(a.usage)) -
          getResetDeadline(getPreferredResetsAt(b.usage));
        if (deadlineDiff !== 0) {
          return otherAccountsSort === "deadline_asc" ? deadlineDiff : -deadlineDiff;
        }
        const remainingDiff =
          getRemainingPercent(getPreferredUsedPercent(b.usage)) -
          getRemainingPercent(getPreferredUsedPercent(a.usage));
        if (remainingDiff !== 0) return remainingDiff;
        return a.name.localeCompare(b.name);
      }

      const remainingDiff =
        getRemainingPercent(getPreferredUsedPercent(b.usage)) -
        getRemainingPercent(getPreferredUsedPercent(a.usage));
      if (otherAccountsSort === "remaining_desc" && remainingDiff !== 0) {
        return remainingDiff;
      }
      if (otherAccountsSort === "remaining_asc" && remainingDiff !== 0) {
        return -remainingDiff;
      }
      const deadlineDiff =
        getResetDeadline(getPreferredResetsAt(a.usage)) -
        getResetDeadline(getPreferredResetsAt(b.usage));
      if (deadlineDiff !== 0) return deadlineDiff;
      return a.name.localeCompare(b.name);
    });
  }, [accounts, otherAccountsSort]);

  const normalizedAccountSearchQuery = isAccountSearchEnabled
    ? accountSearchQuery.trim().toLowerCase()
    : "";
  const selectedPlanTab = runtimePreferences.preferences.selected_plan_tab;
  const setSelectedPlanTab = (key: string) => { void runtimePreferences.change({ selected_plan_tab: key }); };
  const planTabs = useMemo(() => groupAccountsByPlan(accounts, true), [accounts]);
  const effectivePlanTab = selectedPlanTab;
  useEffect(() => {
    if (listReady && runtimePreferences.ready && selectedPlanTab !== "all" && !planTabs.some(tab => tab.key === selectedPlanTab)) {
      void runtimePreferences.change({ selected_plan_tab: "all" });
    }
  }, [listReady, runtimePreferences.ready, runtimePreferences.change, selectedPlanTab, planTabs]);
  const accountPanel = useMemo(() => selectAccountPanel(sortedAccounts, effectivePlanTab), [sortedAccounts, effectivePlanTab]);
  const currentAccount = accountPanel.currentAccount;
  const visibleAccounts = accountPanel.otherAccounts.filter(account => matchesAccountSearch(account, normalizedAccountSearchQuery));
  const hasNoMatchingAccounts = !currentAccount && visibleAccounts.length === 0;
  const getPlanTabLabel = (key: string) => key === "all" ? t("All") : key === "free" ? t("Free accounts") :
    key === "api_key" ? t("API key accounts") : key === "unknown" ? t("Unknown plan") : key;

  const renderAccountCard = (account: AccountWithUsage) => (
    <AccountCard
                      key={account.id}
                      account={account}
                      readOnly={webReadOnly}
                      desktopActions={isTauriRuntime()}
                      onSwitch={() => handleSwitch(account.id)}
                      onRestart={() => void handleSwitch(account.id, true)}
                      onRelogin={() => handleRelogin(account)}
                      onWarmup={() => handleWarmupAccount(account.id, account.name)}
                      onDelete={() => handleDelete(account.id)}
                      onExport={() => openTransfer("export", account.id)}
                      onRefresh={() =>
                        refreshSingleUsage(account.id, { refreshMetadata: true })
                      }
                      onRename={(newName) => renameAccount(account.id, newName)}
                      switching={switchingId === account.id}
                      switchDisabled={switchingId !== null || isForceClosingCodex}
                      codexRunning={hasRunningProcesses ?? false}
                      warmingUp={

                        warmingUpId === account.id ||
                        autoWarmupRunningIds.has(account.id)
                      }
                      masked={maskedAccounts.has(account.id)}
                      onToggleMask={() => toggleMask(account.id)}
                      autoWarmupEnabled={
                        autoWarmupAllEnabled || autoWarmupAccountIds.has(account.id)
                      }
                      autoWarmupManagedByAll={autoWarmupAllEnabled}
                      autoWarmupLabel={getAutoWarmupLabel(
                        account.usage,
                        autoWarmupAllEnabled || autoWarmupAccountIds.has(account.id),
                        autoWarmupRunningIds.has(account.id)
                      )}
                      onToggleAutoWarmup={() => toggleAutoWarmupAccount(account.id)}
                    />
  );

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <WindowResizeBorders isMaximized={isWindowMaximized} />
      <header className="sticky top-0 z-40 border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900">
        <div className="flex h-9 items-center bg-white px-3 dark:bg-gray-900">
          <div
            onMouseDown={handleTitlebarDrag}
            onDoubleClick={handleTitlebarDoubleClick}
            className={`h-full flex-1 select-none cursor-default ${isMacOs ? "ml-18 mr-2" : "mr-3"}`}
          />
          {isTauriRuntime() && !isMacOs && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => {
                  void getTauriWindow()?.minimize();
                }}
                className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
                title={t("Minimize")}
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path d="M5 12h14" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
              <button
                onClick={() => {
                  void getTauriWindow()?.toggleMaximize();
                }}
                className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
                title={t(isWindowMaximized ? "Restore" : "Maximize")}
              >
                {isWindowMaximized ? (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <path d="M9 9h10v10H9z" strokeWidth="2" />
                    <path d="M5 15V5h10" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                    <rect x="5" y="5" width="14" height="14" strokeWidth="2" />
                  </svg>
                )}
              </button>
              <button
                onClick={() => {
                  void getTauriWindow()?.close();
                }}
                className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-red-500 hover:text-white dark:text-gray-400 dark:hover:bg-red-500 dark:hover:text-white"
                title={t("Close")}
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path d="M6 6l12 12M18 6L6 18" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          )}
        </div>

        <div className="max-w-6xl mx-auto px-4 py-4 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <h1 className="truncate text-lg font-bold tracking-tight text-gray-900 dark:text-gray-100 sm:text-xl">
                    {t("Codex Account Manager")}
                  </h1>
                  {processInfo && (
                    <div className="inline-flex shrink-0 items-center gap-1">
                      <span
                        title={hasRunningProcesses ? msg("Codex is running", "Codex 运行中") : msg("Codex is not running", "Codex 未运行")}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs border ${hasRunningProcesses
                            ? "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700"
                            : "bg-green-50 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-700"
                          }`}
                      >
                        <span
                          className={`inline-block w-1.5 h-1.5 rounded-full ${hasRunningProcesses ? "bg-amber-500" : "bg-green-500"
                            }`}
                        ></span>
                        <span>
                          {hasRunningProcesses ? msg("Running", "运行中") : msg("Not running", "未运行")}
                        </span>
                      </span>
                      {hasRunningProcesses && (
                        <button
                          onClick={() => {
                                                  setForceCloseConfirmOpen(true);
                          }}
                          disabled={isForceClosingCodex}
                          className="inline-flex items-center rounded-md border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300 dark:hover:bg-red-900/30"
                          title={t("Close running Codex processes")}
                        >
                          {t("Close")}
                        </button>
                      )}
                    </div>
                  )}
                  {isTauriRuntime() && processInfo && !hasRunningProcesses && (
                    <button
                      onClick={handleOpenCodexApp}
                      disabled={isOpeningCodex || isCompletingForceClose || switchingId !== null}
                      className="inline-flex shrink-0 items-center rounded-md border border-green-200 bg-green-50 px-2 py-0.5 text-xs font-medium text-green-700 transition-colors hover:bg-green-100 disabled:opacity-50 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300 dark:hover:bg-green-900/30"
                      title={t("Open Codex app")}
                    >
                      {isOpeningCodex ? t("Opening...") : t("Open Codex")}
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              <button disabled={webReadOnly} onClick={() => setIsAddModalOpen(true)} title={t("Add account")} aria-label={t("Add account")} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"><ActionIcon name="add" /></button>
              <button
                onClick={toggleMaskAll}
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-gray-100 text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 shrink-0"
                title={allMasked ? t("Show all account names and emails") : t("Hide all account names and emails")}
                aria-label={allMasked ? t("Show all account names and emails") : t("Hide all account names and emails")}
              >
                {allMasked ? (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"
                    />
                  </svg>
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                )}
              </button>
              <button
                onClick={handleRefresh}
                disabled={isRefreshing}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-500 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-wait disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-blue-900/20"
                title={`${isRefreshing ? t("Refreshing...") : t("Refresh usage")}: ${getPlanTabLabel(effectivePlanTab)} · ${t("Including the account in use; invalid accounts skipped")}`} aria-label={`${t("Refresh usage")}: ${getPlanTabLabel(effectivePlanTab)}`}
              >
                <ActionIcon name="refresh" spinning={isRefreshing} />
              </button>
              <button disabled={!isTauriRuntime()} onClick={() => openTransfer("import")} title={t("Import / Export")} aria-label={t("Import / Export")} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"><ActionIcon name="transfer" /></button>
              <button
                onClick={() => setIsSettingsOpen(true)}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-700 transition-colors hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
                title={t("Settings")} aria-label={t("Settings")}
              >
                <ActionIcon name="settings" />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      {!isTauriRuntime() && (
        <div className="mx-4 my-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {webReadOnly ? msg("Web dashboard is read-only. Manage accounts in the desktop app.", "网页版为只读面板，请在桌面应用中管理账号。") : msg("Local account management enabled. Login, JSON transfer and warm-up remain in the desktop app.", "已开启本机账号管理。登录、JSON 导入导出和预热请使用桌面应用。")}
        </div>
      )}
      <main className="max-w-6xl mx-auto px-6 pt-6 pb-8">
        {loading && accounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="animate-spin h-10 w-10 border-2 border-gray-900 dark:border-gray-100 border-t-transparent rounded-full mb-4"></div>
            <p className="text-gray-500 dark:text-gray-400">{t("Loading accounts...")}</p>
          </div>
        ) : error ? (
          <div className="text-center py-20">
            <div className="text-red-600 dark:text-red-300 mb-2">{t("Failed to load accounts")}</div>
            <p className="text-sm text-gray-500 dark:text-gray-400">{localizeError(error, locale)}</p>
          </div>
        ) : accounts.length === 0 ? (
          <div className="text-center py-20">
            <div className="h-16 w-16 rounded-2xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center mx-auto mb-4">
              <span className="text-3xl">👤</span>
            </div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
              {t("No accounts yet")}
            </h2>
            <p className="text-gray-500 dark:text-gray-400 mb-6">
              {t("Add your first Codex account to get started")}
            </p>
            <button
              disabled={webReadOnly}
              onClick={() => setIsAddModalOpen(true)}
              className="px-6 py-3 text-sm font-medium rounded-lg bg-gray-900 hover:bg-gray-800 dark:bg-gray-100 dark:hover:bg-gray-200 text-white dark:text-gray-900 transition-colors"
            >
              {t("Add Account")}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div role="tablist" aria-label={t("Account types")} className="flex gap-2 overflow-x-auto pb-1">
              {["all", ...planTabs.map(tab => tab.key)].map(key => (
                <button key={key} type="button" role="tab" aria-selected={effectivePlanTab === key}
                  aria-controls="account-tab-panel" id={`account-tab-${key}`}
                  tabIndex={effectivePlanTab === key ? 0 : -1}
                  onClick={() => setSelectedPlanTab(key)}
                  onKeyDown={event => {
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                    event.preventDefault();
                    const keys = ["all", ...planTabs.map(tab => tab.key)];
                    const index = keys.indexOf(key);
                    const next = event.key === "Home" ? 0 : event.key === "End" ? keys.length - 1 :
                      (index + (event.key === "ArrowRight" ? 1 : -1) + keys.length) % keys.length;
                    setSelectedPlanTab(keys[next]);
                    (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
                  }}
                  className={`shrink-0 rounded-xl px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${effectivePlanTab === key
                    ? "bg-blue-600 text-white shadow-sm"
                    : "bg-white text-gray-600 hover:bg-gray-100 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"}`}>
                  {getPlanTabLabel(key)}
                </button>
              ))}
            </div>

            {isAccountSearchEnabled && (
              <div className="relative w-full">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-gray-400 dark:text-gray-500">
                  <svg
                    className="h-4 w-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" strokeLinecap="round" />
                  </svg>
                </span>
                <input
                  type="search"
                  value={accountSearchQuery}
                  onChange={(event) => setAccountSearchQuery(event.target.value)}
                  placeholder={t("Search accounts by name or email")}
                  aria-label={t("Search accounts")}
                  className="w-full rounded-xl border border-gray-300 bg-white py-2.5 pl-10 pr-10 text-sm text-gray-900 shadow-sm transition-colors placeholder:text-gray-400 focus:border-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-200 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:placeholder:text-gray-500 dark:focus:border-gray-600 dark:focus:ring-gray-800"
                />
                {accountSearchQuery.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setAccountSearchQuery("")}
                    aria-label={t("Clear account search")}
                    className="absolute inset-y-0 right-2 flex items-center px-2 text-gray-400 transition-colors hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200"
                  >
                    <svg
                      className="h-4 w-4"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <path d="m8 8 8 8M16 8l-8 8" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </div>
            )}

            {visibleAccounts.length > 0 && (
                <div className="flex items-center justify-end gap-3">
                  <div className="flex items-center gap-2">
                    <label htmlFor="other-accounts-sort" className="text-xs text-gray-500 dark:text-gray-400">
                      {t("Sort")}
                    </label>
                    <div className="relative">
                      <CenteredSelect
                        id="other-accounts-sort"
                        value={otherAccountsSort}
                        onChange={(e) =>
                          setOtherAccountsSort(
                            e.target.value as
                              | "deadline_asc"
                              | "deadline_desc"
                              | "remaining_desc"
                              | "remaining_asc"
                              | "subscription_asc"
                              | "subscription_desc"
                          )
                        }
                        className="appearance-none font-sans text-xs sm:text-sm font-medium px-3 py-2 rounded-xl border border-gray-300 dark:border-gray-700 bg-gradient-to-b from-white to-gray-50 dark:from-gray-900 dark:to-gray-800 text-gray-700 dark:text-gray-200 shadow-sm hover:border-gray-400 dark:hover:border-gray-600 hover:shadow focus:outline-none focus:ring-2 focus:ring-gray-300 dark:focus:ring-gray-600 focus:border-gray-400 dark:focus:border-gray-600 transition-all"
                      >
                        <option value="deadline_asc">{t("Reset: earliest to latest")}</option>
                        <option value="deadline_desc">{t("Reset: latest to earliest")}</option>
                        <option value="remaining_desc">
                          {t("% remaining: highest to lowest")}
                        </option>
                        <option value="remaining_asc">
                          {t("% remaining: lowest to highest")}
                        </option>
                        <option value="subscription_asc">
                          {t("Expiry: earliest to latest")}
                        </option>
                        <option value="subscription_desc">
                          {t("Expiry: latest to earliest")}
                        </option>
                      </CenteredSelect>

                    </div>
                  </div>
                </div>
            )}

            <div role="tabpanel" id="account-tab-panel" aria-labelledby={`account-tab-${effectivePlanTab}`} className="space-y-4">
            {currentAccount && <section>{renderAccountCard(currentAccount)}</section>}
            {hasNoMatchingAccounts && (
              <div className="rounded-2xl border border-dashed border-gray-300 px-6 py-12 text-center dark:border-gray-700">
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                  {t("No matching accounts")}
                </h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                  {t("Try a different account name or email address.")}
                </p>
              </div>
            )}

            {visibleAccounts.length > 0 && (
              <section>
                <div className="space-y-4">
                  {groupAccountsByPlan(visibleAccounts, true).map(group => (
                  <section key={group.key} className="col-span-full space-y-3">
                    {effectivePlanTab === "all" && <h2 className="text-sm font-semibold">{getPlanTabLabel(group.key)}</h2>}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {group.accounts.map(renderAccountCard)}
                    </div>
                  </section>
                  ))}
                </div>
              </section>
            )}
            </div>
          </div>
        )}
      </main>

      {/* Refresh Success Toast */}
      {refreshSuccess && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-3 bg-green-600 text-white rounded-lg shadow-lg text-sm flex items-center gap-2">
          <span>✓</span> {t("Usage refreshed successfully")}
        </div>
      )}

      {/* Warm-up Toast */}
      {warmupToast && (
        <div
          className={`fixed bottom-20 left-1/2 -translate-x-1/2 px-4 py-3 rounded-lg shadow-lg text-sm ${
            warmupToast.isError
              ? "bg-red-600 text-white"
              : "bg-amber-100 text-amber-900 border border-amber-300 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-700"
          }`}
        >
          {warmupToast.message}
        </div>
      )}

      {/* Delete Confirmation Toast */}
      {deleteConfirmId && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-3 bg-red-600 text-white rounded-lg shadow-lg text-sm">
          {t("Click delete again to confirm removal")}
        </div>
      )}

      {isSettingsOpen && (
        <SettingsModal
          runtimePreferences={runtimePreferences}
          updater={updater}
          theme={themeMode}
          onThemeChange={setThemeMode}
          autoWarmupEnabled={autoWarmupAllEnabled}
          autoWarmupLabel={`${headerAutoWarmupLabel} · ${getPlanTabLabel(effectivePlanTab)} · ${t("Including the account in use; invalid accounts skipped")}`}
          onAutoWarmupChange={setAutoWarmupAllEnabled}
          warmupAvailable={isTauriRuntime() && accounts.length > 0}
          timedWarmupEnabled={timedWarmupEnabled}
          timedWarmupTimes={timedWarmupTimes}
          timedWarmupLabel={`${timedWarmupLabel} · ${getPlanTabLabel(effectivePlanTab)} · ${t("Including the account in use; invalid accounts skipped")}`}
          onTimedWarmupChange={setTimedWarmupEnabled}
          onTimedWarmupTimesChange={(times) => setTimedWarmupTimes(normalizeTimedWarmupTimes(times))}
          onClose={() => setIsSettingsOpen(false)}
        />
      )}

      {forceCloseConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="switch-confirm-title" className="w-full max-w-md rounded-2xl border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-900">
            <div className="flex items-center justify-between border-b border-gray-100 p-5 dark:border-gray-800">
              <h2 id="switch-confirm-title" className="text-lg font-semibold">{t("Force close Codex")}</h2>
              <button aria-label={t("Cancel")} disabled={isForceClosingCodex} onClick={() => {setForceCloseConfirmOpen(false);}} className="rounded-lg px-2 py-1 text-gray-400 hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-800">✕</button>
            </div>
            <div className="space-y-3 p-5 text-sm text-gray-600 dark:text-gray-300">
              <p>{msg("Force close stops running Codex processes before switching. Unsaved work may be lost.", "将强制关闭正在运行的 Codex 进程并重新打开桌面应用，未保存的内容可能丢失。")}</p>
            </div>
            <div className="flex justify-end gap-3 border-t border-gray-100 p-5 dark:border-gray-800">
              <button disabled={isForceClosingCodex} onClick={() => void handleForceCloseConfirm()} className="rounded-xl bg-red-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">{isForceClosingCodex ? msg("Processing...", "正在处理…") : t("Force close Codex")}</button>
            </div>
          </div>
        </div>
      )}

      {closeBehaviorPromptOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl w-full max-w-md mx-4 shadow-xl">
            <div className="p-5 border-b border-gray-100 dark:border-gray-800">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {t("Keep Codex Account Manager in the Dock?")}
              </h2>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {t("When the window is closed, Codex Account Manager can stay in the Dock or live only in the menu bar.")}
              </p>
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {t("You can always change this later from the tray popup.")}
              </p>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
                <input
                  type="checkbox"
                  checked={closeBehaviorDontAskAgain}
                  onChange={(event) => setCloseBehaviorDontAskAgain(event.target.checked)}
                  className="h-4 w-4 accent-gray-900 dark:accent-gray-100"
                />
                <span>{t("Don't ask again")}</span>
              </label>
            </div>
            <div className="flex flex-col gap-2 p-5 border-t border-gray-100 dark:border-gray-800 sm:flex-row sm:justify-end">
              <button
                onClick={() => setCloseBehaviorPromptOpen(false)}
                disabled={isCompletingCloseBehavior}
                className="px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 transition-colors disabled:opacity-50"
              >
                {t("Cancel")}
              </button>
              <button
                onClick={() => void handleCloseBehaviorChoice("show_in_dock")}
                disabled={isCompletingCloseBehavior}
                className="px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 transition-colors disabled:opacity-50"
              >
                {t("Keep in Dock")}
              </button>
              <button
                onClick={() => void handleCloseBehaviorChoice("menu_bar_only")}
                disabled={isCompletingCloseBehavior}
                className="px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-900 hover:bg-gray-800 dark:bg-gray-100 dark:hover:bg-gray-200 text-white dark:text-gray-900 transition-colors disabled:opacity-50"
              >
                {t("Menu Bar Only")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Account Modal */}
      <AddAccountModal
        isOpen={isAddModalOpen}
        key={reloginAccount?.id ?? "add"}
        initialName={reloginAccount?.name}
        relogin={!!reloginAccount}
        onClose={() => { setIsAddModalOpen(false); setReloginAccount(null); }}
        onStartOAuth={startOAuthLogin}
        onCompleteOAuth={completeOAuthLogin}
        onCancelOAuth={cancelOAuthLogin}
      />

      {/* Import/Export Config Modal */}
      <AccountTransferModal open={isConfigModalOpen} mode={transferMode} accountId={exportAccountId} accounts={accounts} onClose={() => setIsConfigModalOpen(false)} onImported={async (summary) => {const list = await loadAccounts(true);await refreshUsage(list.filter(account => summary.affected_account_ids.includes(account.id)), { refreshMetadata: true });}} />
      <UpdateChecker updater={updater} settingsOpen={isSettingsOpen} />

    </div>
  );
}

export default App;
