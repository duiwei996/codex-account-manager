import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeUsageResult, withUsagePlan } from "../src/lib/usageDisplay.ts";
import { readAccountCache, writeAccountCache } from "../src/lib/accountCache.ts";
import { selectRefreshAccounts } from "../src/lib/refreshPolicy.ts";
import { localizeError } from "../src/lib/errors.ts";
import { USAGE_BASED_PLAN, USAGE_BASED_ERROR } from "../src/lib/accountPlan.ts";
import type { AccountWithUsage, UsageInfo } from "../src/types";

const previous = { account_id: "a", plan_type: "team", primary_used_percent: 25, secondary_used_percent: 60,
  primary_resets_at: 1900000000, credits_balance: "20", recorded_at: "2026-11-09T00:00:00Z", error: null } as UsageInfo;
const converted = { ...previous, plan_type: USAGE_BASED_PLAN, primary_used_percent: 0,
  recorded_at: "2026-11-09T01:00:00Z" };
const account = { id: "a", name: "Team", auth_mode: "chat_g_p_t", plan_type: "team", is_active: true,
  created_at: "2026-11-01T00:00:00Z", usage: previous } as AccountWithUsage;

test("converted seats retain quota and timestamp, pause automatic refresh, and recover on valid manual results", () => {
  const stale = mergeUsageResult(previous, converted);
  assert.deepEqual(stale, { ...previous, error: USAGE_BASED_ERROR, from_cache: true });
  const paused = withUsagePlan({ ...account, usage: stale }, converted);
  assert.equal(paused.credentials_invalid, undefined);
  assert.equal(selectRefreshAccounts([paused], "category", "team", true).length, 1);
  for (const scope of ["current", "category"] as const) {
    for (const tab of ["all", "team", "plus"]) assert.deepEqual(selectRefreshAccounts([paused], scope, tab), []);
  }
  assert.equal(withUsagePlan(paused, { ...previous, from_cache: true }).plan_type, USAGE_BASED_PLAN);
  assert.equal(withUsagePlan(paused, { ...previous, error: "network unavailable" }).plan_type, USAGE_BASED_PLAN);
  assert.deepEqual(mergeUsageResult(stale, converted), stale);
  const normal = { ...previous, primary_used_percent: 30, recorded_at: "2026-11-09T02:00:00Z" };
  const recovered = withUsagePlan({ ...paused, usage: mergeUsageResult(stale, normal) }, normal);
  assert.equal(recovered.plan_type, "team");
  assert.equal(recovered.usage?.primary_used_percent, 30);
  assert.equal(recovered.usage?.error, null);
  assert.equal(selectRefreshAccounts([recovered], "current").length, 1);
});

test("converted results without a valid prior cache never become zero or fresh quota", () => {
  for (const cached of [undefined, { ...previous, account_id: "b" }, converted]) {
    const result = mergeUsageResult(cached, converted);
    assert.equal(result.primary_used_percent, null);
    assert.equal(result.recorded_at, undefined);
    assert.equal(result.error, USAGE_BASED_ERROR);
  }
  assert.match(localizeError(USAGE_BASED_ERROR, "zh-CN"), /团队按量付费.*刷新失败.*暂停自动刷新/);
  assert.match(localizeError(USAGE_BASED_ERROR, "en-US"), /Team pay-as-you-go/);
});

test("restart retains paused state and valid cached quota without promoting old converted quota", () => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value),
  } } });
  try {
    const paused = withUsagePlan({ ...account, usage: mergeUsageResult(previous, converted) }, converted);
    writeAccountCache([paused]);
    assert.equal(JSON.parse([...storage.values()][0])[0].usage.error, null);
    const restored = readAccountCache()[0];
    assert.equal(restored.plan_type, USAGE_BASED_PLAN);
    assert.equal(restored.usage?.primary_used_percent, 25);
    assert.equal(restored.usage?.recorded_at, previous.recorded_at);
    assert.equal(restored.usage?.error, USAGE_BASED_ERROR);
    assert.equal(restored.usage?.from_cache, true);
    assert.deepEqual(selectRefreshAccounts([restored], "current"), []);
    writeAccountCache([{ ...paused, usage: converted }], true);
    assert.equal(readAccountCache()[0].usage, undefined);
  } finally { Reflect.deleteProperty(globalThis, "window"); }
});
