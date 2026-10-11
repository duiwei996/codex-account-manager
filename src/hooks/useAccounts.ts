import { useState, useEffect, useCallback, useRef } from "react";
import type {
  AccountInfo,
  UsageInfo,
  AccountWithUsage,
  WarmupSummary,
} from "../types";
import { invokeBackend, isTauriRuntime, type FileSource } from "../lib/platform";
import { mergeUsageResult } from "../lib/usageDisplay";

export function useAccounts() {
  const [accounts, setAccounts] = useState<AccountWithUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const accountsRef = useRef<AccountWithUsage[]>([]);
  const metadataRefreshInFlightRef = useRef(new Set<string>());
  const maxConcurrentUsageRequests = 4;
  const loadGenerationRef = useRef(0);
  const usageInFlightRef = useRef(new Map<string, Promise<UsageInfo>>());
  const requestUsage = useCallback((accountId: string): Promise<UsageInfo> => {
    const pending = usageInFlightRef.current.get(accountId);
    if (pending) return pending;
    const request = invokeBackend<UsageInfo>("get_usage", { accountId }).finally(() => {
      if (usageInFlightRef.current.get(accountId) === request) usageInFlightRef.current.delete(accountId);
    });
    usageInFlightRef.current.set(accountId, request);
    return request;
  }, []);

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  const buildUsageError = useCallback(
    (accountId: string, message: string, planType: string | null): UsageInfo => ({
      account_id: accountId,
      plan_type: planType,
      primary_used_percent: null,
      primary_window_minutes: null,
      primary_resets_at: null,
      secondary_used_percent: null,
      secondary_window_minutes: null,
      secondary_resets_at: null,
      has_credits: null,
      unlimited_credits: null,
      credits_balance: null,
      error: message,
    }),
    []
  );

  // Push freshly polled usage down to the tray (single poller feeds the tray menu).
  const reportUsageToTray = useCallback((usages: UsageInfo[]) => {
    if (!isTauriRuntime() || usages.length === 0) return;
    void invokeBackend("report_usage", { usages }).catch(() => {});
  }, []);

  const runWithConcurrency = useCallback(
    async <T,>(
      items: T[],
      worker: (item: T) => Promise<void>,
      concurrency: number
    ) => {
      if (items.length === 0) return;
      const limit = Math.min(Math.max(concurrency, 1), items.length);
      let index = 0;
      const runners = Array.from({ length: limit }, async () => {
        while (true) {
          const current = index++;
          if (current >= items.length) return;
          await worker(items[current]);
        }
      });
      await Promise.allSettled(runners);
    },
    []
  );

  const loadAccounts = useCallback(async (preserveUsage = false) => {
    const generation = ++loadGenerationRef.current;
    try {
      setLoading(true);
      setError(null);
      const accountList = await invokeBackend<AccountInfo[]>("list_accounts");
      if (generation !== loadGenerationRef.current) return [];

      if (preserveUsage) {
        // Preserve existing usage data when just updating account info
        setAccounts((prev) => {
          const usageMap = new Map(
            prev.map((a) => [a.id, { usage: a.usage, usageLoading: a.usageLoading }])
          );
          return accountList.map((a) => ({
            ...a,
            usage: usageMap.get(a.id)?.usage,
            usageLoading: usageMap.get(a.id)?.usageLoading,
          }));
        });
      } else {
        setAccounts(accountList.map((a) => ({ ...a, usageLoading: false })));
      }
      return accountList;
    } catch (err) {
      if (generation === loadGenerationRef.current) setError(err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }, []);

  const refreshMetadata = useCallback(
    async (
      accountList?: AccountInfo[] | AccountWithUsage[]
    ) => {
      const list = accountList ?? accountsRef.current;
      const dueAccounts = list.filter(
        (account) => !metadataRefreshInFlightRef.current.has(account.id)
      );

      // Mark attempts before starting requests so overlapping refresh cycles
      // cannot issue duplicate metadata calls for the same account.
      dueAccounts.forEach((account) => {
        metadataRefreshInFlightRef.current.add(account.id);
      });

      await runWithConcurrency(
        dueAccounts,
        async (account) => {
          try {
            const metadata = await invokeBackend<AccountInfo>("refresh_account_metadata", {
              accountId: account.id,
            });
            setAccounts((prev) =>
              prev.map((item) =>
                item.id === account.id
                  ? {
                      ...item,
                      plan_type: metadata.plan_type ?? item.plan_type,
                      subscription_expires_at: metadata.subscription_expires_at ?? item.subscription_expires_at,
                    }
                  : item
              )
            );
          } catch (err) {
            console.warn("Failed to refresh account metadata:", err);
          } finally {
            metadataRefreshInFlightRef.current.delete(account.id);
          }
        },
        maxConcurrentUsageRequests
      );
    },
    [maxConcurrentUsageRequests, runWithConcurrency]
  );

  const refreshUsage = useCallback(
    async (
      accountList?: AccountInfo[] | AccountWithUsage[],
      options?: { refreshMetadata?: boolean }
    ) => {
      try {
        const list = accountList ?? accountsRef.current;
        if (list.length === 0) {
          return;
        }

        // Explicit refreshes include metadata, but run it beside usage so a
        // slow accounts endpoint never delays healthy rate-limit updates.
        const metadataPromise = options?.refreshMetadata
          ? refreshMetadata(list)
          : Promise.resolve();

        const accountIds = list.map((account) => account.id);
        const accountIdSet = new Set(accountIds);
        const usageResults = new Map<string, UsageInfo>();

        setAccounts((prev) =>
          prev.map((account) =>
            accountIdSet.has(account.id)
              ? { ...account, usageLoading: true }
              : account
          )
        );

        await runWithConcurrency(
          list,
          async (account) => {
            try {
              const usage = await requestUsage(account.id);
              usageResults.set(account.id, usage);
            } catch (err) {
              console.error("Failed to refresh usage:", err);
              const message = err instanceof Error ? err.message : String(err);
              usageResults.set(
                account.id,
                buildUsageError(account.id, message, account.plan_type ?? null)
              );
            }
          },
          maxConcurrentUsageRequests
        );

        setAccounts((prev) =>
          prev.map((account) => {
            const usage = usageResults.get(account.id);
            if (!usage) return account;
            return {
              ...account,
              usage: mergeUsageResult(account.usage, usage),
              usageLoading: false,
            };
          })
        );

        reportUsageToTray(Array.from(usageResults.values()));
        await metadataPromise;
        return Array.from(usageResults.values());
      } catch (err) {
        console.error("Failed to refresh usage:", err);
        throw err;
      }
    },
    [
      buildUsageError,
      requestUsage,
      maxConcurrentUsageRequests,
      refreshMetadata,
      reportUsageToTray,
      runWithConcurrency,
    ]
  );

  const refreshSingleUsage = useCallback(async (
    accountId: string,
    options?: { refreshMetadata?: boolean }
  ) => {
    try {
      const account = accountsRef.current.find((item) => item.id === accountId);
      const metadataPromise = options?.refreshMetadata && account
        ? refreshMetadata([account])
        : Promise.resolve();

      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId ? { ...a, usageLoading: true } : a
        )
      );
      const usage = await requestUsage(accountId);
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId ? { ...a, usage: mergeUsageResult(a.usage, usage), usageLoading: false } : a
        )
      );
      reportUsageToTray([usage]);
      await metadataPromise;
      return usage;
    } catch (err) {
      console.error("Failed to refresh single usage:", err);
      const message = err instanceof Error ? err.message : String(err);
      setAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId
            ? {
                ...a,
                usage: mergeUsageResult(a.usage, buildUsageError(accountId, message, a.plan_type ?? null)),
                usageLoading: false,
              }
            : a
        )
      );
      throw err;
    }
  }, [buildUsageError, refreshMetadata, reportUsageToTray, requestUsage]);

  const warmupAccount = useCallback(async (accountId: string) => {
    try {
      await invokeBackend("warmup_account", { accountId });
    } catch (err) {
      console.error("Failed to warm up account:", err);
      throw err;
    }
  }, []);

  const warmupAllAccounts = useCallback(async () => {
    try {
      return await invokeBackend<WarmupSummary>("warmup_all_accounts");
    } catch (err) {
      console.error("Failed to warm up all accounts:", err);
      throw err;
    }
  }, []);

  const switchAccount = useCallback(
    async (accountId: string, allowRunning = false) => {
      try {
        await invokeBackend("switch_account", { accountId, allowRunning });
        await loadAccounts(true); // Preserve usage data
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts]
  );

  const deleteAccount = useCallback(
    async (accountId: string) => {
      try {
        await invokeBackend("delete_account", { accountId });
        // Account activation can change while deletion is in flight. Re-read
        // backend metadata without discarding the latest cached usage.
        await loadAccounts(true);
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts]
  );

  const renameAccount = useCallback(
    async (accountId: string, newName: string) => {
      try {
        await invokeBackend("rename_account", { accountId, newName });
        await loadAccounts(true); // Preserve usage data
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts]
  );

  const importFromFile = useCallback(
    async (source: FileSource, name: string) => {
      try {
        if (typeof source === "string") {
          await invokeBackend<AccountInfo>("add_account_from_file", { path: source, name });
        } else {
          const contents = await source.text();
          await invokeBackend<AccountInfo>("add_account_from_auth_json_text", {
            name,
            contents,
          });
        }
        const accountList = await loadAccounts();
        await refreshUsage(accountList);
      } catch (err) {
        throw err;
      }
    },
    [loadAccounts, refreshUsage]
  );

  const startOAuthLogin = useCallback(async (accountName: string) => {
    try {
      const info = await invokeBackend<{ auth_url: string; callback_port: number }>(
        "start_login",
        { accountName }
      );
      return info;
    } catch (err) {
      throw err;
    }
  }, []);

  const completeOAuthLogin = useCallback(async () => {
    try {
      const account = await invokeBackend<AccountInfo>("complete_login");
      const accountList = await loadAccounts();
      await refreshUsage(accountList);
      return account;
    } catch (err) {
      throw err;
    }
  }, [loadAccounts, refreshUsage]);

  const cancelOAuthLogin = useCallback(async () => {
    try {
      await invokeBackend("cancel_login");
    } catch (err) {
      console.error("Failed to cancel login:", err);
    }
  }, []);

  const loadMaskedAccountIds = useCallback(async () => {
    try {
      return await invokeBackend<string[]>("get_masked_account_ids");
    } catch (err) {
      console.error("Failed to load masked account IDs:", err);
      return [];
    }
  }, []);

  const saveMaskedAccountIds = useCallback(async (ids: string[]) => {
    try {
      await invokeBackend("set_masked_account_ids", { ids });
    } catch (err) {
      console.error("Failed to save masked account IDs:", err);
    }
  }, []);

  useEffect(() => {
    loadAccounts().then((accountList) => {
      void refreshUsage(accountList);
      // Populate live expiry immediately. The native background process keeps
      // its cache current while a desktop webview is hidden or suspended.
      void refreshMetadata(accountList);
    });

    // Auto-refresh usage every 60 seconds (same as official Codex CLI)
    const usageInterval = setInterval(() => {
      refreshUsage().catch(() => {});
    }, 60000);

    const metadataInterval = !isTauriRuntime()
      ? setInterval(() => {
          refreshMetadata().catch(() => {});
        }, 6 * 60 * 60 * 1000)
      : undefined;

    return () => {
      clearInterval(usageInterval);
      if (metadataInterval !== undefined) clearInterval(metadataInterval);
    };
  }, [loadAccounts, refreshMetadata, refreshUsage]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void (async () => {
      if (!("__TAURI_INTERNALS__" in window)) return;
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen("accounts-changed", () => {
        void loadAccounts(true);
      });
    })();

    return () => unlisten?.();
  }, [loadAccounts]);

  return {
    accounts,
    loading,
    error,
    loadAccounts,
    refreshUsage,
    refreshSingleUsage,
    warmupAccount,
    warmupAllAccounts,
    switchAccount,
    deleteAccount,
    renameAccount,
    importFromFile,
    startOAuthLogin,
    completeOAuthLogin,
    cancelOAuthLogin,
    loadMaskedAccountIds,
    saveMaskedAccountIds,
  };
}
