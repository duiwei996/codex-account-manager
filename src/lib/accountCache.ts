import type { AccountWithUsage, AccountUsageStats, UsageInfo } from "../types";

export const ACCOUNT_CACHE_KEY = "codex-switcher-account-display-cache-v1";
export const STATS_CACHE_KEY = "codex-switcher-account-stats-cache-v1";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown): string | null => typeof value === "string" ? value.slice(0, 1000) : null;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const date = (value: unknown): string | undefined => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
function read(key: string): unknown {
  try { return JSON.parse(window.localStorage.getItem(key) ?? "null"); } catch { return null; }
}
function write(key: string, value: unknown): void {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage failure must not clear visible data. */ }
}

function cleanUsage(value: unknown, accountId: string): UsageInfo | undefined {
  if (!object(value) || value.account_id !== accountId || !date(value.recorded_at)) return undefined;
  return {
    account_id: accountId, recorded_at: date(value.recorded_at), from_cache: true, error: null,
    plan_type: string(value.plan_type),
    primary_used_percent: number(value.primary_used_percent), primary_window_minutes: number(value.primary_window_minutes), primary_resets_at: number(value.primary_resets_at),
    secondary_used_percent: number(value.secondary_used_percent), secondary_window_minutes: number(value.secondary_window_minutes), secondary_resets_at: number(value.secondary_resets_at),
    has_credits: typeof value.has_credits === "boolean" ? value.has_credits : null,
    unlimited_credits: typeof value.unlimited_credits === "boolean" ? value.unlimited_credits : null,
    credits_balance: string(value.credits_balance),
  };
}
function cleanAccount(value: unknown): AccountWithUsage | undefined {
  if (!object(value) || typeof value.id !== "string" || typeof value.name !== "string" || !["api_key", "chat_g_p_t"].includes(String(value.auth_mode))) return undefined;
  return {
    id: value.id, name: value.name, email: string(value.email), plan_type: string(value.plan_type),
    subscription_expires_at: date(value.subscription_expires_at) ?? null,
    auth_mode: value.auth_mode as AccountWithUsage["auth_mode"], is_active: value.is_active === true,
    credentials_invalid: value.credentials_invalid === true,
    created_at: date(value.created_at) ?? new Date(0).toISOString(), last_used_at: date(value.last_used_at) ?? null,
    metadata_recorded_at: date(value.metadata_recorded_at), usage: cleanUsage(value.usage, value.id), usageLoading: false,
  };
}
export function readAccountCache(): AccountWithUsage[] {
  const value = read(ACCOUNT_CACHE_KEY);
  if (!Array.isArray(value)) return [];
  return value.slice(0, 200).map(cleanAccount).filter((account): account is AccountWithUsage => !!account);
}
export function writeAccountCache(accounts: AccountWithUsage[]): void {
  // Project only display fields. Errors, pending requests and credentials are never persisted.
  write(ACCOUNT_CACHE_KEY, accounts.map(cleanAccount).filter(Boolean));
}

function cleanStats(value: unknown, accountId: string): AccountUsageStats | null {
  if (!object(value) || value.account_id !== accountId || value.available !== true || !object(value.summary) || !object(value.activity)) return null;
  const summary = value.summary;
  const activity = value.activity;
  return {
    account_id: accountId, available: true, from_cache: true, error: null,
    source: string(value.source) ?? "", generated_at: date(value.generated_at) ?? null, stats_as_of: string(value.stats_as_of),
    summary: { lifetime_tokens: number(summary.lifetime_tokens), peak_daily_tokens: number(summary.peak_daily_tokens), longest_task_seconds: number(summary.longest_task_seconds), current_streak_days: number(summary.current_streak_days), longest_streak_days: number(summary.longest_streak_days) },
    activity: { fast_mode_percent: number(activity.fast_mode_percent), reasoning_effort: string(activity.reasoning_effort), reasoning_effort_percent: number(activity.reasoning_effort_percent), skills_explored: number(activity.skills_explored), total_skills_used: number(activity.total_skills_used), total_threads: number(activity.total_threads) },
    daily: Array.isArray(value.daily) ? value.daily.filter(object).slice(0, 366).map(row => ({ date: string(row.date) ?? "", tokens: number(row.tokens) ?? 0 })) : [],
    top_invocations: Array.isArray(value.top_invocations) ? value.top_invocations.filter(object).slice(0, 100).map(row => ({ kind: string(row.kind) ?? "", display_name: string(row.display_name) ?? "", usage_count: number(row.usage_count) ?? 0, plugin_id: string(row.plugin_id), plugin_name: string(row.plugin_name), skill_id: string(row.skill_id), skill_name: string(row.skill_name) })) : [],
    reset_credits: null,
  };
}
export function readStatsCache(accountId: string): AccountUsageStats | null {
  const value = read(STATS_CACHE_KEY);
  return object(value) ? cleanStats(value[accountId], accountId) : null;
}
export function writeStatsCache(stats: AccountUsageStats): void {
  if (!stats.available || stats.error) return;
  const entry = cleanStats(stats, stats.account_id);
  if (!entry) return;
  const current = read(STATS_CACHE_KEY);
  const entries: Record<string, unknown> = {};
  if (object(current)) {
    for (const id of Object.keys(current).slice(-199)) { const old = cleanStats(current[id], id); if (old) entries[id] = old; }
  }
  entries[stats.account_id] = entry;
  write(STATS_CACHE_KEY, entries);
}
