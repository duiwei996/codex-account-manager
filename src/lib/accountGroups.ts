import type { AccountInfo } from "../types";

export function getAccountPlanKey(account: AccountInfo) {
  return account.auth_mode === "api_key"
    ? "api_key"
    : account.plan_type?.trim().toLowerCase() || "unknown";
}

/** Preserve the selected sort order within each plan; never infer a free plan. */
export function groupAccountsByPlan<T extends AccountInfo>(accounts: readonly T[], includeActive = false) {
  const groups = new Map<string, T[]>();
  for (const account of accounts) {
    if (account.is_active && !includeActive) continue;
    const key = getAccountPlanKey(account);
    const group = groups.get(key) ?? [];
    group.push(account);
    groups.set(key, group);
  }
  const order = ["free", "plus", "team", "pro", "business", "enterprise", "edu", "api_key", "unknown"];
  return [...groups].sort(([a], [b]) => {
    const rank = (key: string) => key === "unknown" ? 100 : order.includes(key) ? order.indexOf(key) : 50;
    return rank(a) - rank(b) || a.localeCompare(b);
  }).map(([key, accounts]) => ({ key, accounts }));
}
