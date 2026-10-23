import assert from "node:assert/strict";
import { test } from "node:test";
import { getAccountPlanKey, groupAccountsByPlan, selectAccountPanel } from "../src/lib/accountGroups.ts";
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

test("invalid accounts finish each type group, including invalid active accounts", () => {
  const accounts = [
    {id: "invalid-active", plan_type: "team", is_active: true, credentials_invalid: true},
    {id: "plus-invalid", plan_type: "plus", is_active: false, credentials_invalid: true},
    {id: "team-valid", plan_type: "team", is_active: false},
    {id: "plus-valid", plan_type: "plus", is_active: false},
  ].map(a => ({...a, auth_mode: "chat_g_p_t"})) as AccountInfo[];
  assert.deepEqual(groupAccountsByPlan(accounts, true).map(g => g.accounts.map(a => a.id)),
    [["plus-valid", "plus-invalid"], ["team-valid", "invalid-active"]]);
});

test("current account remains pinned in every category and never repeats in the groups", () => {
  const accounts = [
    {id: "free", plan_type: "free", is_active: false},
    {id: "current", plan_type: "team", is_active: true, credentials_invalid: true},
    {id: "plus", plan_type: "plus", is_active: false},
    {id: "team", plan_type: "team", is_active: false},
  ].map(a => ({...a, auth_mode: "chat_g_p_t"})) as AccountInfo[];
  for (const tab of ["all", "free", "plus", "team", "unknown"]) {
    const panel = selectAccountPanel(accounts, tab);
    assert.equal(panel.currentAccount?.id, "current");
    assert.ok(!panel.otherAccounts.some(account => account.id === "current"));
    if (tab !== "all") assert.ok(panel.otherAccounts.every(account => getAccountPlanKey(account) === tab));
  }
  assert.equal(selectAccountPanel(accounts.filter(a => !a.is_active), "team").currentAccount, undefined);
});


test("risk isolation excludes active and inactive accounts from ordinary panels and restores their plans", () => {
  const accounts = [
    { id: "active", plan_type: "free", is_active: true, risk_controlled: true },
    { id: "risk", plan_type: "team", is_active: false, risk_controlled: true },
    { id: "normal", plan_type: "team", is_active: false },
  ] as AccountInfo[];
  assert.equal(selectAccountPanel(accounts, "all").currentAccount, undefined);
  assert.deepEqual(selectAccountPanel(accounts, "all").otherAccounts.map(a => a.id), ["normal"]);
  assert.deepEqual(selectAccountPanel(accounts, "team").otherAccounts.map(a => a.id), ["normal"]);
  assert.equal(selectAccountPanel(accounts, "risk").currentAccount?.id, "active");
  assert.deepEqual(selectAccountPanel(accounts, "risk").otherAccounts.map(a => a.id), ["risk"]);
  assert.equal(getAccountPlanKey(accounts[1]), "risk");
  accounts[1].risk_controlled = false;
  assert.equal(getAccountPlanKey(accounts[1]), "team");
  assert.deepEqual(selectAccountPanel(accounts, "team").otherAccounts.map(a => a.id), ["risk", "normal"]);
});
