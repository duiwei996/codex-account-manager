import type { AccountWithUsage, UsageInfo } from "../types";
const LIMIT_FULL_THRESHOLD = 99.5;
export function isLimitFull(usedPercent: number | null | undefined): boolean {
  return usedPercent !== null && usedPercent !== undefined && usedPercent >= LIMIT_FULL_THRESHOLD;
}

export function getPreferredUsedPercent(usage: UsageInfo | undefined): number | null | undefined {
  return usage?.primary_used_percent ?? usage?.secondary_used_percent;
}

export function getPreferredResetsAt(usage: UsageInfo | undefined): number | null | undefined {
  return usage?.primary_resets_at ?? usage?.secondary_resets_at;
}

export function getTimedWarmupTargets(accounts: AccountWithUsage[]): AccountWithUsage[] {
  return accounts.filter(
    (account) =>
      account.usage &&
      !account.usageLoading &&
      !account.usage.error &&
      !isLimitFull(account.usage.secondary_used_percent)
  );
}

export function matchesAccountSearch(
  account: AccountWithUsage,
  normalizedQuery: string
): boolean {
  if (!normalizedQuery) return true;

  return (
    account.name.toLowerCase().includes(normalizedQuery) ||
    account.email?.toLowerCase().includes(normalizedQuery) === true
  );
}
