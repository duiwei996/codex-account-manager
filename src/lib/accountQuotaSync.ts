import type { AccountInfo, AccountResetCredits, AccountWithUsage, UsageInfo } from "../types";
import { ACCOUNT_QUOTA_CHANGED_EVENT, cacheTime, cleanUsage, mergeAccountQuota, readAccountCache, readResetCreditsCache, writeAccountCache, writeResetCreditsCache } from "./accountCache";

export interface AccountSyncCache {
  metadata?: { recorded_at:string; subscription_expires_at:string | null };
  usage?: Omit<UsageInfo,"account_id" | "plan_type" | "error" | "from_cache" | "recorded_at"> & { recorded_at:string };
  resets?: { recorded_at:string; credits:{ id:string; expires_at:string | null; title:string | null }[] };
}
export function collectAccountSyncCaches(): Record<string,AccountSyncCache> {
  const result: Record<string,AccountSyncCache> = {};
  for (const account of readAccountCache()) {
    const cache: AccountSyncCache = {};
    if (cacheTime(account.metadata_recorded_at)) cache.metadata = { recorded_at:account.metadata_recorded_at!,subscription_expires_at:account.subscription_expires_at };
    const u = cleanUsage(account.usage,account.id);
    if (u?.recorded_at) cache.usage = { recorded_at:u.recorded_at,primary_used_percent:u.primary_used_percent,primary_window_minutes:u.primary_window_minutes,primary_resets_at:u.primary_resets_at,secondary_used_percent:u.secondary_used_percent,secondary_window_minutes:u.secondary_window_minutes,secondary_resets_at:u.secondary_resets_at,has_credits:u.has_credits,unlimited_credits:u.unlimited_credits,credits_balance:u.credits_balance };
    const reset = readResetCreditsCache(account.id);
    if (reset) cache.resets = { recorded_at:reset.recorded_at,credits:reset.data.credits.map(c=>({ id:c.id,expires_at:c.expires_at,title:c.title })) };
    if (Object.keys(cache).length) result[account.id] = cache;
  }
  return result;
}
export function applyAccountSyncCaches(accounts: AccountInfo[], caches: Record<string,AccountSyncCache>): void {
  const previous = new Map(readAccountCache().map(a=>[a.id,a]));
  const next: AccountWithUsage[] = accounts.map(account => {
    const old = previous.get(account.id);
    const cache = caches[account.id];
    let merged: AccountWithUsage = { ...account,subscription_expires_at:cacheTime(old?.metadata_recorded_at) ? old!.subscription_expires_at : account.subscription_expires_at,metadata_recorded_at:old?.metadata_recorded_at,usage:old?.usage,usageLoading:false };
    if (!cache) return mergeAccountQuota(merged,old);
    if (cache.metadata && cacheTime(cache.metadata.recorded_at) >= cacheTime(old?.metadata_recorded_at)) merged = { ...merged,subscription_expires_at:cache.metadata.subscription_expires_at,metadata_recorded_at:cache.metadata.recorded_at };
    if (cache.usage && cacheTime(cache.usage.recorded_at) >= cacheTime(old?.usage?.recorded_at)) merged.usage = cleanUsage({ ...cache.usage,account_id:account.id,plan_type:account.plan_type },account.id);
    if (cache.resets) {
      const data:AccountResetCredits = { available_count:0,next_expires_at:null,credits:cache.resets.credits.map(c=>({ ...c,status:"available",reset_type:"",granted_at:null,redeem_started_at:null,redeemed_at:null,description:null })) };
      writeResetCreditsCache(account.id,data,cache.resets.recorded_at);
    }
    return mergeAccountQuota(merged,old);
  });
  writeAccountCache(next);
  window.dispatchEvent(new Event(ACCOUNT_QUOTA_CHANGED_EVENT));
}
