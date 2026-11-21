import type { AccountWithUsage, UsageInfo } from "../types";
const LIMIT_FULL_THRESHOLD = 99.5;
export function isLimitFull(usedPercent: number | null | undefined): boolean {
  return usedPercent !== null && usedPercent !== undefined && usedPercent >= LIMIT_FULL_THRESHOLD;
}

export function getPreferredUsedPercent(usage: UsageInfo | undefined): number | null | undefined {
  return usage?.primary_used_percent ?? usage?.secondary_used_percent;
}

export function getWeeklyResetsAt(usage: UsageInfo | undefined): number | null {
  if (!usage) return null;
  // Older cached responses can still have the weekly window in the primary slot.
  const weeklyMinutes = 7 * 24 * 60;
  if (usage.secondary_window_minutes === weeklyMinutes) return usage.secondary_resets_at ?? null;
  if (usage.primary_window_minutes === weeklyMinutes) return usage.primary_resets_at ?? null;
  return usage.secondary_window_minutes == null ? usage.secondary_resets_at ?? null : null;
}

export function getTimedWarmupTargets(accounts: AccountWithUsage[]): AccountWithUsage[] {
  return accounts.filter(
    (account) =>
      account.usage &&
      !account.usageLoading &&
      !account.usage.error &&
      !account.usage.from_cache &&
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
