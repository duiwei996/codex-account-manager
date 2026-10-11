import type { UsageInfo } from "../types";

/** Keep the last server values visible, explicitly marked stale on failure. */
export function mergeUsageResult(previous: UsageInfo | undefined, incoming: UsageInfo): UsageInfo {
  if (!incoming.error) return { ...incoming, recorded_at: incoming.recorded_at ?? new Date().toISOString() };
  if (!previous || previous.account_id !== incoming.account_id) return incoming;
  return { ...previous, error: incoming.error };
}
