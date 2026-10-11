import assert from "node:assert/strict";
import { test } from "node:test";
import { getAccountPlanKey, groupAccountsByPlan } from "../src/lib/accountGroups.ts";
import type { AccountInfo } from "../src/types";

test("plan grouping omits the pinned account and empty groups while preserving sort order", () => {
  const account = (id: string, plan_type: string | null, extra = {}) => ({
    id, plan_type, auth_mode: "chat_g_p_t", is_active: false, ...extra,
  }) as AccountInfo;
  const accounts = [
    account("current", "team", {is_active: true}),
    account("team-first", "TEAM"), account("unknown", null),
    account("free", "free"), account("plus", "plus"),
    account("team-second", " team "), account("api", "plus", {auth_mode: "api_key"}),
  ];
  const groups = groupAccountsByPlan(accounts);
  assert.deepEqual(groups.map(group => group.key), ["free", "plus", "team", "api_key", "unknown"]);
  assert.deepEqual(groups.find(group => group.key === "team")?.accounts.map(account => account.id), ["team-first", "team-second"]);
  assert.equal(groups.flatMap(group => group.accounts).length, 6);
  assert.equal(accounts.length, 7);
  assert.deepEqual(groupAccountsByPlan([]), []);
  assert.deepEqual(groupAccountsByPlan([account("current", "plus", {is_active: true})]), []);
  assert.deepEqual(groupAccountsByPlan([account("unknown", " ")]).map(group => group.key), ["unknown"]);
});

test("dynamic tabs include types held only by the current account and normalize filtering keys", () => {
  const accounts = [
    {id: "current", plan_type: "PRO", auth_mode: "chat_g_p_t", is_active: true},
    {id: "other", plan_type: " plus ", auth_mode: "chat_g_p_t", is_active: false},
    {id: "api", plan_type: "pro", auth_mode: "api_key", is_active: false},
  ] as AccountInfo[];
  assert.deepEqual(groupAccountsByPlan(accounts, true).map(tab => tab.key), ["plus", "pro", "api_key"]);
  assert.deepEqual(accounts.filter(account => getAccountPlanKey(account) === "pro").map(account => account.id), ["current"]);
  assert.deepEqual(groupAccountsByPlan(accounts.slice(1), true).map(tab => tab.key), ["plus", "api_key"]);
});
