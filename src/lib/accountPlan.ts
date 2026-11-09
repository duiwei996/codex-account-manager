export const USAGE_BASED_PLAN = "self_serve_business_usage_based";
export const USAGE_BASED_ERROR = "Team pay-as-you-go: usage refresh failed; automatic refresh paused";
export function isUsageRefreshPaused(plan?: string | null): boolean {
  return plan?.trim().toLowerCase() === USAGE_BASED_PLAN;
}

/** Seat conversions remain in the team category; retain the raw type as refresh state. */
export function normalizeAccountPlan(plan?: string | null): string {
  const key = plan?.trim().toLowerCase() || "unknown";
  return isUsageRefreshPaused(key) ? "team" : key;
}
