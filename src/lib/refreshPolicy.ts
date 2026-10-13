export type RefreshScope = "current" | "all";
export const REFRESH_INTERVALS = [30, 60, 120, 300, 600] as const;

export function selectRefreshAccounts<T extends { is_active: boolean }>(accounts: T[], scope: RefreshScope): T[] {
  return scope === "all" ? accounts : accounts.filter(account => account.is_active);
}

export function refreshDelay(seconds: number, foreground: boolean): number {
  const safeSeconds = REFRESH_INTERVALS.includes(seconds as typeof REFRESH_INTERVALS[number]) ? seconds : 60;
  return safeSeconds * 1000 * (foreground ? 1 : 5);
}
