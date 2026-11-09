import type { AccountInfo, UsageInfo } from "../types";
import { isUsageRefreshPaused, USAGE_BASED_ERROR, USAGE_BASED_PLAN } from "./accountPlan.ts";

/** The plan accompanying Codex quota also determines its label and category. */
export function withUsagePlan<T extends AccountInfo>(account: T, usage?: UsageInfo): T {
  if (account.auth_mode === "chat_g_p_t" && usage?.account_id === account.id) {
    if (isUsageRefreshPaused(usage.plan_type)) return { ...account, plan_type: USAGE_BASED_PLAN };
    if (isUsageRefreshPaused(account.plan_type) && (usage.from_cache || usage.error)) return account;
  }
  if (account.auth_mode !== "chat_g_p_t" || usage?.account_id !== account.id ||
      (usage.error && !usage.recorded_at) || !usage.plan_type?.trim()) return account;
  const plan = usage.plan_type.trim().toLowerCase();
  return { ...account, plan_type: plan,
    subscription_expires_at: plan === "free" ? null : account.subscription_expires_at };
}

/** Keep the last server values visible, explicitly marked stale on failure. */
export function mergeUsageResult(previous: UsageInfo | undefined, incoming: UsageInfo): UsageInfo {
  if (isUsageRefreshPaused(incoming.plan_type)) {
    const failed = { ...incoming, plan_type: null, primary_used_percent: null, primary_window_minutes: null,
      primary_resets_at: null, secondary_used_percent: null, secondary_window_minutes: null,
      secondary_resets_at: null, has_credits: null, unlimited_credits: null, credits_balance: null,
      recorded_at: undefined, from_cache: true, error: USAGE_BASED_ERROR };
    return previous?.account_id === incoming.account_id && previous.recorded_at && !isUsageRefreshPaused(previous.plan_type)
      ? { ...previous, from_cache: true, error: USAGE_BASED_ERROR } : failed;
  }
  if (!incoming.error) return { ...incoming, from_cache: incoming.from_cache ?? false, recorded_at: incoming.recorded_at ?? new Date().toISOString() };
  if (!previous || previous.account_id !== incoming.account_id) return incoming;
  return { ...previous, error: incoming.error };
}
