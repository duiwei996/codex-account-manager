export type RefreshScope = "current" | "category";
export const REFRESH_INTERVALS = [30, 60, 120, 300, 600] as const;

export function selectRefreshAccounts<T extends { is_active: boolean; credentials_invalid?: boolean; auth_mode?: string; plan_type?: string | null }>(accounts: T[], scope: RefreshScope, category = "all"): T[] {
  return accounts.filter(account => !account.credentials_invalid && (scope === "current" ? account.is_active :
    account.is_active || category === "all" || (account.auth_mode === "api_key" ? "api_key" : account.plan_type?.trim().toLowerCase() || "unknown") === category));
}

export function refreshDelay(seconds: number, foreground: boolean): number {
  const safeSeconds = REFRESH_INTERVALS.includes(seconds as typeof REFRESH_INTERVALS[number]) ? seconds : 60;
  return safeSeconds * 1000 * (foreground ? 1 : 5);
}
