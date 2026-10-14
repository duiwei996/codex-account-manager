import { readStatsCache, writeStatsCache } from "../lib/accountCache";
import { ActionIcon } from "./ActionIcon";
import { getLocale, tr, useLocale } from "../lib/i18n";
import { useCallback, useState, useRef, useEffect } from "react";
import type { AccountResetCredits, AccountUsageStats as AccountUsageStatsInfo, AccountWithUsage } from "../types";
import { invokeBackend } from "../lib/platform";
import { AccountUsageStats, formatTokens } from "./AccountUsageStats";
import { ResetCreditsMenu } from "./ResetCreditsMenu";
import { UsageBar } from "./UsageBar";

const RESET_CREDITS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface AccountCardProps {
  account: AccountWithUsage;
  onSwitch: () => void;
  onRestart?: () => void;
  onWarmup: () => Promise<void>;
  onDelete: () => void;
  onExport: () => void;
  onRefresh: () => Promise<unknown>;
  onRename: (newName: string) => Promise<void>;
  readOnly?: boolean;
  desktopActions?: boolean;
  switching?: boolean;
  switchDisabled?: boolean;
  codexRunning?: boolean;
  warmingUp?: boolean;
  masked?: boolean;
  onToggleMask?: () => void;
  autoWarmupEnabled?: boolean;
  autoWarmupManagedByAll?: boolean;
  autoWarmupLabel?: string;
  onToggleAutoWarmup?: () => void;
}

function formatLastRefresh(date: Date | null): string {
  if (!date) return tr("Never", getLocale());
  const now = new Date();
  const diff = Math.floor((now.getTime() - date.getTime()) / 1000);
  if (diff < 5) return tr("Just now", getLocale());
  if (diff < 60) return getLocale() === "zh-CN" ? `${diff} 秒前` : `${diff}s ago`;
  if (diff < 3600) return getLocale() === "zh-CN" ? `${Math.floor(diff / 60)} 分钟前` : `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return getLocale() === "zh-CN" ? `${Math.floor(diff / 3600)} 小时前` : `${Math.floor(diff / 3600)}h ago`;
  return date.toLocaleDateString(getLocale());
}

function getSubscriptionStatus(timestamp: string | null | undefined): {
  label: string;
  className: string;
} {
  if (!timestamp) {
    return {
      label: tr("Subscription expiry unavailable", getLocale()),
      className: "text-gray-400 dark:text-gray-500",
    };
  }

  const expiryDate = new Date(timestamp);
  const formattedDate = new Intl.DateTimeFormat(getLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(expiryDate);

  const remainingMs = expiryDate.getTime() - Date.now();
  if (remainingMs <= 0) {
    return {
      label: getLocale() === "zh-CN" ? `已于 ${formattedDate} 到期` : `Expired ${formattedDate}`,
      className: "text-red-500 dark:text-red-400",
    };
  }

  if (remainingMs <= 3 * 24 * 60 * 60 * 1000) {
    return {
      label: getLocale() === "zh-CN" ? `有效期至 ${formattedDate}` : `Until ${formattedDate}`,
      className: "text-red-500 dark:text-red-400",
    };
  }

  if (remainingMs <= 7 * 24 * 60 * 60 * 1000) {
    return {
      label: getLocale() === "zh-CN" ? `有效期至 ${formattedDate}` : `Until ${formattedDate}`,
      className: "text-amber-500 dark:text-amber-400",
    };
  }

  return {
    label: getLocale() === "zh-CN" ? `有效期至 ${formattedDate}` : `Until ${formattedDate}`,
    className: "text-gray-400 dark:text-gray-500",
  };
}

function BlurredText({ children, blur }: { children: React.ReactNode; blur: boolean }) {
  return (
    <span
      className={`transition-all duration-200 select-none ${blur ? "blur-sm" : ""}`}
      style={blur ? { userSelect: "none" } : undefined}
    >
      {children}
    </span>
  );
}

export function AccountCard({
  account,
  onSwitch,
  onRestart,
  onWarmup,
  onDelete,
  onExport,
  onRefresh,
  onRename,
  switching,
  readOnly = false,
  desktopActions = true,
  switchDisabled,
  codexRunning = false,
  warmingUp,
  masked = false,
  onToggleMask,
  autoWarmupEnabled = false,
  autoWarmupManagedByAll = false,
  autoWarmupLabel,
  onToggleAutoWarmup,
}: AccountCardProps) {
  const locale = useLocale();
  const t = (text: string) => tr(text, locale);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(
    account.usage?.recorded_at ? new Date(account.usage.recorded_at) : null
  );
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(account.name);
  const [resetCredits, setResetCredits] = useState<AccountResetCredits | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const closeStats = useCallback(() => setStatsOpen(false), []);
  const [usageStats, setUsageStats] = useState<AccountUsageStatsInfo | null>(() => readStatsCache(account.id));
  const inputRef = useRef<HTMLInputElement>(null);
  const resetRequestSeq = useRef(0);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    if (account.usage && !account.usage.error) {
      setLastRefresh(account.usage.recorded_at ? new Date(account.usage.recorded_at) : new Date());
    }
  }, [account.usage]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleRename = async () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== account.name) {
      try {
        if (readOnly) return;
        await onRename(trimmed);
      } catch {
        setEditName(account.name);
      }
    } else {
      setEditName(account.name);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleRename();
    } else if (e.key === "Escape") {
      setEditName(account.name);
      setIsEditing(false);
    }
  };

  const planDisplay = account.plan_type?.toLowerCase() || (account.auth_mode === "api_key" ? "API Key" : t("Unknown"));

  const planColors: Record<string, string> = {
    pro: "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-700",
    plus: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700",
    team: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700",
    enterprise: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700",
    free: "bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700",
    api_key: "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-700",
  };

  const planKey = account.plan_type?.toLowerCase() || "api_key";
  const planColorClass = planColors[planKey] || planColors.free;
  const showSubscriptionStatus =
    account.auth_mode === "chat_g_p_t" && account.plan_type?.toLowerCase() !== "free";
  const subscriptionStatus = getSubscriptionStatus(account.subscription_expires_at);
  const compactResetCredits = !account.is_active;

  const loadResetCredits = useCallback(async () => {
    const requestId = ++resetRequestSeq.current;

    if (account.auth_mode !== "chat_g_p_t") {
      setResetCredits(null);
      return;
    }

    try {
      const stats = await invokeBackend<AccountUsageStatsInfo>("get_account_usage_stats", {
        accountId: account.id,
      });
      if (requestId !== resetRequestSeq.current) return;
      setResetCredits(stats.account_id === account.id ? stats.reset_credits : null);
      if (stats.account_id === account.id && stats.available && !stats.error) { writeStatsCache(stats); setUsageStats({ ...stats, from_cache: false }); }
    } catch {
      if (requestId !== resetRequestSeq.current) return;
      setResetCredits(null);
    }
  }, [account.auth_mode, account.id]);

  const handleStatsLoaded = useCallback(
    (stats: AccountUsageStatsInfo | null) => {
      if (!stats || stats.account_id !== account.id) return;
      setResetCredits(stats.reset_credits);
      if (stats.available && !stats.error) { writeStatsCache(stats); setUsageStats({ ...stats, from_cache: false }); }
    },
    [account.id]
  );

  useEffect(() => {
    setResetCredits(null);
    setUsageStats(readStatsCache(account.id));
    setStatsOpen(false);

    void loadResetCredits();
    const timer = window.setInterval(() => {
      void loadResetCredits();
    }, RESET_CREDITS_REFRESH_INTERVAL_MS);

    return () => {
      resetRequestSeq.current += 1;
      window.clearInterval(timer);
    };
  }, [loadResetCredits]);


  return (
    <div
      className={`relative rounded-2xl border p-6 transition-all duration-200 ${
        account.is_active
          ? "bg-white dark:bg-gray-900 border-blue-400 shadow-sm ring-2 ring-blue-50 dark:ring-blue-900/20"
          : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 hover:border-blue-200 hover:shadow-md dark:hover:border-gray-600"
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {account.is_active && (
              <span className="shrink-0 rounded-md bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-600 dark:bg-blue-950 dark:text-blue-300">{t("Current")}</span>
            )}
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={handleRename}
                onKeyDown={handleKeyDown}
                maxLength={120}
                aria-label={t("Rename")}
                className="w-full rounded-lg border border-blue-300 bg-white px-2 py-1 font-semibold text-gray-900 outline-none focus:ring-2 focus:ring-blue-100 dark:bg-gray-800 dark:text-gray-100"
              />
            ) : (
              <h3
                className="truncate font-semibold text-gray-900 dark:text-gray-100"
              >
                <BlurredText blur={masked}>{account.name}</BlurredText>
              </h3>
            )}
            {!isEditing && <button disabled={readOnly || masked} onClick={() => {setEditName(account.name);setIsEditing(true);}} title={t("Rename")} aria-label={t("Rename")} className="shrink-0 rounded-md p-1 text-gray-400 hover:bg-blue-50 hover:text-blue-600 disabled:opacity-40 dark:hover:bg-blue-950"><ActionIcon name="rename" /></button>}
          </div>
          {account.email && (
            <p className="text-sm text-gray-500 dark:text-gray-400 truncate">
              <BlurredText blur={masked}>{account.email}</BlurredText>
            </p>
          )}
        </div>

        <div className="flex max-w-[60%] flex-wrap items-center justify-end gap-2">
          {/* Eye toggle */}
          {onToggleMask && (
            <button
              disabled={readOnly}
              onClick={onToggleMask}
              className="p-1 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              title={masked ? t("Show info") : t("Hide info")}
            >
              {masked ? (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              )}
            </button>
          )}
          {/* Plan badge */}
          <span
            className={`px-2.5 py-1 text-xs font-medium rounded-full border ${planColorClass}`}
          >
            {planDisplay}
          </span>
          <ResetCreditsMenu
            compact={compactResetCredits}
            resetCredits={resetCredits}
          />
        </div>
      </div>

      <div className={`mb-4 grid grid-cols-1 gap-4 ${account.is_active ? "sm:grid-cols-2" : ""}`}>
        <section className="min-w-0 rounded-xl bg-gray-50 p-3 dark:bg-gray-950/40">
          <h4 className="mb-3 text-xs font-medium text-gray-500 dark:text-gray-400">{locale === "zh-CN" ? "账号额度" : "Allowance"}</h4>
          <UsageBar usage={account.usage} loading={isRefreshing || account.usageLoading} />
          {account.usage?.error && <button onClick={() => void handleRefresh().catch(() => {})} disabled={isRefreshing || account.usageLoading} className="mt-2 text-xs font-medium text-blue-600 hover:underline disabled:opacity-50 dark:text-blue-400">{t("Retry")}</button>}
        </section>
        {account.is_active && (
          <section className="min-w-0 rounded-xl bg-gray-50 p-3 dark:bg-gray-950/40">
            <h4 className="mb-3 text-xs font-medium text-gray-500 dark:text-gray-400">{t("Usage statistics")}</h4>
            <dl className="space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2"><dt className="text-gray-500">{t("Lifetime")}</dt><dd className="font-semibold tabular-nums">{formatTokens(usageStats?.summary.lifetime_tokens)}</dd></div>
              <div className="flex items-center justify-between gap-2"><dt className="text-gray-500">{t("Peak day")}</dt><dd className="font-semibold tabular-nums">{formatTokens(usageStats?.summary.peak_daily_tokens)}</dd></div>
              <div className="flex items-center justify-between gap-2"><dt className="text-gray-500">{t("Total threads")}</dt><dd className="font-semibold tabular-nums">{usageStats?.activity.total_threads?.toLocaleString(locale) ?? "--"}</dd></div>
            </dl>
          </section>
        )}
      </div>

      {/* Last refresh time */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs mb-3">
        <div className="text-gray-400 dark:text-gray-500">
          {t("Last updated")}: {formatLastRefresh(lastRefresh)}
        </div>
        {showSubscriptionStatus && (
          <div className={`text-right ${subscriptionStatus.className}`}>
            {subscriptionStatus.label}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2 mt-3">
        {account.is_active ? (
          <button
            onClick={onRestart}
            disabled={readOnly || !desktopActions || !onRestart || switching || switchDisabled}
            title={t("Reapply this account and restart Codex")}
            className="flex-1 px-4 py-2 text-sm font-medium rounded-lg bg-blue-100 hover:bg-blue-200 dark:bg-blue-900/30 dark:hover:bg-blue-900/50 text-blue-800 dark:text-blue-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {switching ? t("Restarting Codex...") : t("Restart Codex")}
          </button>
        ) : (
          <button
            onClick={onSwitch}
            disabled={readOnly || switching || switchDisabled}
            className={`flex-1 flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              codexRunning
                ? "bg-blue-100 hover:bg-blue-200 dark:bg-blue-900/30 dark:hover:bg-blue-900/50 text-blue-800 dark:text-blue-300"
                : "bg-gray-900 hover:bg-gray-800 dark:bg-gray-100 dark:hover:bg-gray-200 text-white dark:text-gray-900"
            }`}
            title={codexRunning ? t("Close running Codex processes and switch account") : undefined}
          >
            {codexRunning && !switching && (
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.3 3.9 1.8 18.1A2 2 0 003.5 21h17a2 2 0 001.7-2.9L13.7 3.9a2 2 0 00-3.4 0Z" />
              </svg>
            )}
            {switching ? t("Switching...") : t("Switch")}
          </button>
        )}
        <button onClick={handleRefresh} disabled={isRefreshing} title={t("Refresh usage")} aria-label={t("Refresh usage")} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-wait disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-blue-900/20"><ActionIcon name="refresh" spinning={isRefreshing} /></button>
        <button onClick={onExport} disabled={readOnly || !desktopActions} title={t("Export JSON")} aria-label={t("Export JSON")} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300 hover:brightness-95 disabled:opacity-50"><ActionIcon name="export" /></button>
        <button onClick={() => void onWarmup()} disabled={!desktopActions || warmingUp} title={t("Send warm-up")} aria-label={t("Send warm-up")} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700 dark:bg-amber-900/20 hover:brightness-95 disabled:opacity-50"><ActionIcon name="warmup" /></button>
        <button onClick={() => setStatsOpen(true)} title={t("Usage statistics")} aria-label={t("Usage statistics")} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-600 hover:bg-blue-50 hover:text-blue-600 dark:bg-gray-800 dark:text-gray-300"><ActionIcon name="stats" /></button>
        {onToggleAutoWarmup && <button disabled={!desktopActions || autoWarmupManagedByAll} onClick={onToggleAutoWarmup} aria-pressed={autoWarmupEnabled} title={`${t("Auto Warm Up")}: ${autoWarmupLabel ?? t(autoWarmupEnabled ? "on" : "off")}`} aria-label={t("Auto Warm Up")} className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-50 ${autoWarmupEnabled ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950" : "bg-gray-100 text-gray-500 dark:bg-gray-800"}`}><ActionIcon name="auto" /></button>}
        <button onClick={onDelete} disabled={readOnly} title={t("Remove account")} aria-label={t("Remove account")} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-600 dark:bg-red-900/20 hover:brightness-95 disabled:opacity-50"><ActionIcon name="delete" /></button>
      </div>
      <AccountUsageStats
        accountId={account.id}
        accountName={masked ? t("Usage statistics") : account.name}
        onClose={closeStats}
        enabled={account.auth_mode === "chat_g_p_t"}
        open={statsOpen}
        usage={account.usage}
        usageLoading={account.usageLoading}
        onStatsLoaded={handleStatsLoaded}
      />
    </div>
  );
}
