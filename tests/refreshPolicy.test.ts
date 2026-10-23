import assert from "node:assert/strict";
import { test } from "node:test";
import { refreshDelay, selectRefreshAccounts } from "../src/lib/refreshPolicy.ts";

test("current scope only requests the active account, including after a switch", () => {
  const accounts = [{ id: "old", is_active: true }, { id: "new", is_active: false }];
  assert.deepEqual(selectRefreshAccounts(accounts, "current").map(a => a.id), ["old"]);
  const switched = accounts.map(a => ({ ...a, is_active: a.id === "new" }));
  assert.deepEqual(selectRefreshAccounts(switched, "current").map(a => a.id), ["new"]);
  assert.deepEqual(selectRefreshAccounts(accounts, "category"), accounts);
  assert.deepEqual(selectRefreshAccounts(accounts.map(a => ({ ...a, is_active: false })), "current"), []);
});
test("background intervals are longer and corrupted preferences cannot create a tight loop", () => {
  assert.equal(refreshDelay(60, true), 60_000);
  assert.equal(refreshDelay(60, false), 300_000);
  assert.equal(refreshDelay(300, false), 1_500_000);
  for (const value of [0, -1, NaN, Infinity, 123]) assert.equal(refreshDelay(value, true), 60_000);
});

test("category refresh filters plans and never refreshes invalid credentials, even active ones", () => {
  const accounts = [
    { id: "active-invalid", is_active: true, credentials_invalid: true, plan_type: "team" },
    { id: "team", is_active: false, plan_type: " TEAM " },
    { id: "plus", is_active: false, plan_type: "plus" },
    { id: "invalid-team", is_active: false, credentials_invalid: true, plan_type: "team" },
    { id: "api", is_active: false, auth_mode: "api_key", plan_type: "team" },
  ];
  assert.deepEqual(selectRefreshAccounts(accounts, "current"), []);
  assert.deepEqual(selectRefreshAccounts(accounts, "category", "team").map(a => a.id), ["team"]);
  assert.deepEqual(selectRefreshAccounts(accounts, "category", "api_key").map(a => a.id), ["api"]);
  assert.deepEqual(selectRefreshAccounts(accounts, "category", "all").map(a => a.id), ["team", "plus", "api"]);
});

test("category includes a valid account in use across tabs exactly once", () => {
  const accounts = [
    { id: "active", is_active: true, plan_type: "plus" },
    { id: "team", is_active: false, plan_type: "team" },
    { id: "other", is_active: false, plan_type: "free" },
    { id: "invalid", is_active: false, plan_type: "team", credentials_invalid: true },
  ];
  const ids = (scope: "current" | "category", tab: string) => selectRefreshAccounts(accounts, scope, tab).map(a => a.id);
  assert.deepEqual(ids("category", "team"), ["active", "team"]);
  assert.deepEqual(ids("category", "plus"), ["active"]);
  assert.deepEqual(ids("category", "all"), ["active", "team", "other"]);
  assert.deepEqual(ids("category", "unknown"), ["active"]);
  assert.deepEqual(ids("current", "team"), ["active"]);
});


test("isolated accounts are excluded from current, all and plan refreshes", () => {
  const accounts = [
    { id: "active-risk", is_active: true, plan_type: "team", risk_controlled: true },
    { id: "risk", is_active: false, plan_type: "team", risk_controlled: true },
    { id: "normal", is_active: false, plan_type: "team" },
  ];
  assert.deepEqual(selectRefreshAccounts(accounts, "current"), []);
  assert.deepEqual(selectRefreshAccounts(accounts, "category", "all").map(a => a.id), ["normal"]);
  assert.deepEqual(selectRefreshAccounts(accounts, "category", "team").map(a => a.id), ["normal"]);
  assert.deepEqual(selectRefreshAccounts(accounts, "category", "risk"), []);
});
