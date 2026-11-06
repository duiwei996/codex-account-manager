import type { AccountInfo, UsageInfo } from "../types";

/** The plan accompanying Codex quota also determines its label and category. */
export function withUsagePlan<T extends AccountInfo>(account: T, usage?: UsageInfo): T {
  if (account.auth_mode !== "chat_g_p_t" || usage?.account_id !== account.id ||
      (usage.error && !usage.recorded_at) || !usage.plan_type?.trim()) return account;
  const plan = usage.plan_type.trim().toLowerCase();
  return { ...account, plan_type: plan,
    subscription_expires_at: plan === "free" ? null : account.subscription_expires_at };
}

/** Keep the last server values visible, explicitly marked stale on failure. */
export function mergeUsageResult(previous: UsageInfo | undefined, incoming: UsageInfo): UsageInfo {
  if (!incoming.error) return { ...incoming, from_cache: incoming.from_cache ?? false, recorded_at: incoming.recorded_at ?? new Date().toISOString() };
  if (!previous || previous.account_id !== incoming.account_id) return incoming;
  return { ...previous, error: incoming.error };
}
