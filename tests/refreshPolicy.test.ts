import assert from "node:assert/strict";
import { test } from "node:test";
import { refreshDelay, selectRefreshAccounts } from "../src/lib/refreshPolicy.ts";

test("current scope only requests the active account, including after a switch", () => {
  const accounts = [{ id: "old", is_active: true }, { id: "new", is_active: false }];
  assert.deepEqual(selectRefreshAccounts(accounts, "current").map(a => a.id), ["old"]);
  const switched = accounts.map(a => ({ ...a, is_active: a.id === "new" }));
  assert.deepEqual(selectRefreshAccounts(switched, "current").map(a => a.id), ["new"]);
  assert.deepEqual(selectRefreshAccounts(accounts, "all"), accounts);
  assert.deepEqual(selectRefreshAccounts(accounts.map(a => ({ ...a, is_active: false })), "current"), []);
});
test("background intervals are longer and corrupted preferences cannot create a tight loop", () => {
  assert.equal(refreshDelay(60, true), 60_000);
  assert.equal(refreshDelay(60, false), 300_000);
  assert.equal(refreshDelay(300, false), 1_500_000);
  for (const value of [0, -1, NaN, Infinity, 123]) assert.equal(refreshDelay(value, true), 60_000);
});
