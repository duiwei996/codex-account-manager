import { getDisplayPlan, isAccountUnavailable, isUsageRefreshPaused, normalizeAccountPlan, USAGE_BASED_PLAN } from "../lib/accountPlan.ts";
import { RESET_CACHE_CHANGED_EVENT, readResetCreditsCache, writeResetCreditsCache } from "../lib/accountCache";
import { ActionIcon } from "./ActionIcon";
import { getLocale, tr, useLocale } from "../lib/i18n";
import { useCallback, useState, useRef, useEffect } from "react";
import { Check, Copy, Pencil } from "lucide-react";
import type { AccountResetCredits, AccountWithUsage } from "../types";
import { invokeBackend } from "../lib/platform";
import { ResetCreditsMenu } from "./ResetCreditsMenu";
import { UsageBar } from "./UsageBar";

const RESET_CREDITS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DISPLAY_PLANS = [
  ["free", "Free"],
  ["plus", "Plus"],
  ["pro", "Pro"],
  ["team", "Team"],
  [USAGE_BASED_PLAN, "Team pay-as-you-go"],
  ["business", "Business"],
  ["enterprise", "Enterprise"],
  ["edu", "Edu"],
] as const;

interface AccountCardProps {
  account: AccountWithUsage;
  onSwitch: () => void;
  onRestart?: () => void;
  onRelogin?: () => void;
  onWarmup: () => Promise<void>;
  onDelete: () => void;
  onExport: () => void;
  onToggleRisk: () => Promise<void>;
  onRefresh: () => Promise<unknown>;
  onRename: (newName: string) => Promise<void>;
  onChangeDisplayPlan?: (plan: string | null) => Promise<void>;
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
  onRelogin,
  onRestart,
  onWarmup,
  onDelete,
  onExport,
  onToggleRisk,
  onRefresh,
  onRename,
  onChangeDisplayPlan,
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
  const [emailCopy, setEmailCopy] = useState<"copied" | "failed" | null>(null);
  const [editingPlan, setEditingPlan] = useState(false);
  const [savingPlan, setSavingPlan] = useState(false);
  const [planSaveFailed, setPlanSaveFailed] = useState(false);
  const [resetCredits, setResetCredits] = useState<AccountResetCredits | null>(() => account.auth_mode === "chat_g_p_t" ? readResetCreditsCache(account.id)?.data ?? null : null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resetRequestSeq = useRef(0);

  useEffect(() => {
    if (emailCopy !== "copied") return;
    const timer = setTimeout(() => setEmailCopy(null), 2000);
    return () => clearTimeout(timer);
  }, [emailCopy]);

  const copyEmail = async () => {
    if (!account.email || masked) return;
    try {
      await navigator.clipboard.writeText(account.email);
      setEmailCopy("copied");
    } catch {
      setEmailCopy("failed");
    }
  };

  const saveDisplayPlan = async (plan: string | null) => {
    if (!onChangeDisplayPlan || readOnly || savingPlan) return;
    setSavingPlan(true);
    setPlanSaveFailed(false);
    try {
      await onChangeDisplayPlan(plan);
      setEditingPlan(false);
    } catch {
      setPlanSaveFailed(true);
    } finally {
      setSavingPlan(false);
    }
  };

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

  const payAsYouGo = isUsageRefreshPaused(account.plan_type);
  const unavailable = isAccountUnavailable(account);

  const planColors: Record<string, string> = {
    pro: "bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-900/30 dark:text-indigo-300 dark:border-indigo-700",
    plus: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700",
    team: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700",
    enterprise: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700",
    free: "bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-700",
    api_key: "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-700",
  };

  const manualPlan = account.credentials_invalid ? account.display_plan_override : null;
  const planKey = account.auth_mode === "api_key" ? "api_key" : normalizeAccountPlan(getDisplayPlan(account));
  const planDisplay = planKey === "api_key" ? "API Key"
    : planKey === "unknown" ? t("Unknown") : planKey;
  const manualPlanLabel = DISPLAY_PLANS.find(([value]) => value === manualPlan)?.[1];
  const planColorClass = planColors[planKey] || planColors.free;
  const editablePlan = !!onChangeDisplayPlan && account.auth_mode === "chat_g_p_t" && account.credentials_invalid && !readOnly;
  const showSubscriptionStatus =
    account.auth_mode === "chat_g_p_t" && account.plan_type?.toLowerCase() !== "free";
  const subscriptionStatus = getSubscriptionStatus(account.subscription_expires_at);
  const compactResetCredits = !account.is_active;

  const loadResetCredits = useCallback(async () => {
    const requestId = ++resetRequestSeq.current;

    if (account.risk_controlled || account.credentials_invalid || isUsageRefreshPaused(account.plan_type) || account.auth_mode !== "chat_g_p_t") {
      setResetCredits(account.auth_mode === "chat_g_p_t" ? readResetCreditsCache(account.id)?.data ?? null : null);
      return;
    }

    try {
      const credits = await invokeBackend<AccountResetCredits>("get_account_reset_credits", {
        accountId: account.id,
      });
      if (requestId !== resetRequestSeq.current) return;
      writeResetCreditsCache(account.id, credits);
      setResetCredits(readResetCreditsCache(account.id)?.data ?? null);
    } catch {
      if (requestId !== resetRequestSeq.current) return;
      setResetCredits(readResetCreditsCache(account.id)?.data ?? null);
    }
  }, [account.auth_mode, account.id, account.credentials_invalid, account.risk_controlled, account.plan_type]);

  useEffect(() => {
    setResetCredits(account.auth_mode === "chat_g_p_t" ? readResetCreditsCache(account.id)?.data ?? null : null);

    void loadResetCredits();
    const timer = window.setInterval(() => {
      void loadResetCredits();
    }, RESET_CREDITS_REFRESH_INTERVAL_MS);

    return () => {
      resetRequestSeq.current += 1;
      window.clearInterval(timer);
    };
  }, [loadResetCredits]);

  useEffect(() => {
    const update = () => setResetCredits(account.auth_mode === "chat_g_p_t" ? readResetCreditsCache(account.id)?.data ?? null : null);
    window.addEventListener(RESET_CACHE_CHANGED_EVENT,update);
    return () => window.removeEventListener(RESET_CACHE_CHANGED_EVENT,update);
  }, [account.id,account.auth_mode]);


  return (
    <div
      className={`relative rounded-2xl border p-6 transition-all duration-200 ${
        unavailable
          ? "bg-red-50/40 dark:bg-red-950/10 border-red-500 dark:border-red-400 ring-2 ring-red-100 dark:ring-red-900/30"
          : account.is_active
          ? "bg-white dark:bg-gray-900 border-blue-400 shadow-sm ring-2 ring-blue-50 dark:ring-blue-900/20"
          : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 hover:border-blue-200 hover:shadow-md dark:hover:border-gray-600"
      }`}
    >
      {/* Header */}
      <header className="mb-3 space-y-1">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
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
            {editablePlan ? (
              <button type="button" aria-expanded={editingPlan} aria-label={t("Change display plan")}
                title={t("Change display plan")} disabled={savingPlan}
                onClick={() => { setEditingPlan(!editingPlan); setPlanSaveFailed(false); }}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium hover:brightness-95 ${planColorClass}`}>
                {planDisplay}<Pencil size={12} aria-hidden="true" />
              </button>
            ) : (
              <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${planColorClass}`}>{planDisplay}</span>
            )}
            <ResetCreditsMenu
              compact={compactResetCredits}
              resetCredits={resetCredits}
            />
          </div>
        </div>
        {(account.email || account.credentials_invalid || payAsYouGo) && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {account.email && (
              <div className="flex min-w-0 max-w-full items-center gap-1 text-sm text-gray-500 dark:text-gray-400">
                <span className={`min-w-0 truncate ${masked ? "select-none blur-sm" : "select-text"}`}>{account.email}</span>
                <button
                  type="button"
                  disabled={masked}
                  onClick={() => void copyEmail()}
                  aria-label={t("Copy email")}
                  title={t(emailCopy === "copied" ? "Copied" : "Copy email")}
                  className="shrink-0 rounded-md p-1 text-gray-400 hover:bg-blue-50 hover:text-blue-600 focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40 dark:hover:bg-blue-950"
                >
                  {emailCopy === "copied" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                </button>
              </div>
            )}
            {account.credentials_invalid && (
              <span className="rounded-md bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300">{t("Login expired")}</span>
            )}
            {payAsYouGo && (
              <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">{t("Team pay-as-you-go")}</span>
            )}
            {manualPlanLabel && (!payAsYouGo || manualPlan !== USAGE_BASED_PLAN) && (
              <span className="shrink-0 whitespace-nowrap rounded-md bg-blue-50 px-1.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">{t("Manual plan label").replace("{plan}", t(manualPlanLabel))}</span>
            )}
          </div>
        )}
        {account.email && (
          <p role="status" className={emailCopy === "failed" && !masked ? "text-xs text-amber-700 dark:text-amber-300" : "sr-only"}>
            {!masked && (emailCopy === "copied" ? t("Copied") : emailCopy === "failed" ? t("Clipboard unavailable. Please copy manually.") : null)}
          </p>
        )}
      </header>

      {editablePlan && editingPlan && (
        <div className="mb-3 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
          <label className="flex flex-wrap items-center gap-2">
            {t("Display plan")}
            <select disabled={savingPlan} value={manualPlan ?? ""}
              onChange={event => void saveDisplayPlan(event.target.value || null)}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 dark:border-gray-600 dark:bg-gray-900">
              <option value="">{t("Detect plan automatically")}</option>
              {DISPLAY_PLANS.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
            </select>
          </label>
          {planSaveFailed && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{t("Could not save display plan")}</p>}
        </div>
      )}

      <section className="mb-4 min-w-0 rounded-xl bg-gray-50 p-3 dark:bg-gray-950/40">
        <h4 className="mb-3 text-xs font-medium text-gray-500 dark:text-gray-400">{locale === "zh-CN" ? "账号额度" : "Allowance"}</h4>
        <UsageBar usage={account.usage} loading={isRefreshing || account.usageLoading} refreshPaused={payAsYouGo} />
        {account.credentials_invalid && !payAsYouGo && account.usage && <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{t("Cached usage")}</p>}
      </section>

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
      <div className="mt-3 space-y-2">
        <div className="flex w-full">
        {unavailable ? (
          <button onClick={onRelogin} disabled={readOnly || !onRelogin || switching || switchDisabled} className="w-full whitespace-nowrap px-4 py-2 text-sm font-medium rounded-lg bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 disabled:opacity-50">{t("Sign in again")}</button>
        ) : account.is_active ? (
          <button
            onClick={onRestart}
            disabled={readOnly || !desktopActions || !onRestart || switching || switchDisabled}
            title={t("Reapply this account and restart Codex")}
            className="w-full whitespace-nowrap px-4 py-2 text-sm font-medium rounded-lg bg-blue-100 hover:bg-blue-200 dark:bg-blue-900/30 dark:hover:bg-blue-900/50 text-blue-800 dark:text-blue-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {switching ? t("Restarting Codex...") : t("Restart Codex")}
          </button>
        ) : (
          <button
            onClick={onSwitch}
            disabled={readOnly || switching || switchDisabled}
            className={`w-full whitespace-nowrap flex items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
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
        </div>
        <div className="flex flex-wrap gap-2">
        <button onClick={handleRefresh} disabled={isRefreshing || account.usageLoading} title={t("Refresh usage")} aria-label={t("Refresh usage")} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-wait disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-blue-900/20"><ActionIcon name="refresh" spinning={isRefreshing} /></button>
        <button disabled={readOnly} onClick={() => void onToggleRisk()} title={t(account.risk_controlled ? "Move out of risk control" : "Move to risk control")} aria-label={t(account.risk_controlled ? "Move out of risk control" : "Move to risk control")} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300 hover:brightness-95 disabled:opacity-50"><ActionIcon name={account.risk_controlled ? "risk-remove" : "risk-add"} /></button>
        <button onClick={onExport} disabled={readOnly || !desktopActions} title={t("Export JSON")} aria-label={t("Export JSON")} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300 hover:brightness-95 disabled:opacity-50"><ActionIcon name="export" /></button>
        <button onClick={() => void onWarmup()} disabled={unavailable || !desktopActions || warmingUp} title={t("Send warm-up")} aria-label={t("Send warm-up")} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-700 dark:bg-amber-900/20 hover:brightness-95 disabled:opacity-50"><ActionIcon name="warmup" /></button>
        {onToggleAutoWarmup && <button disabled={unavailable || !desktopActions || autoWarmupManagedByAll} onClick={onToggleAutoWarmup} aria-pressed={autoWarmupEnabled} title={`${t("Auto Warm Up")}: ${autoWarmupLabel ?? t(autoWarmupEnabled ? "on" : "off")}`} aria-label={t("Auto Warm Up")} className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-50 ${autoWarmupEnabled ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-950" : "bg-gray-100 text-gray-500 dark:bg-gray-800"}`}><ActionIcon name="auto" /></button>}
        <button onClick={onDelete} disabled={readOnly} title={t("Remove account")} aria-label={t("Remove account")} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-600 dark:bg-red-900/20 hover:brightness-95 disabled:opacity-50"><ActionIcon name="delete" /></button>
        </div>
      </div>
    </div>
  );
}
