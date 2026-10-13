import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement, act, useState } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const subscriptions = new Map();
const callbacks = new Map();
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(_event, id) { subscriptions.delete(id); } };
const calls = [];
let callbackId = 0;
const defaults = { autostart_enabled: true, startup_minimized: true, automatic_update_checks: true, refresh_scope: "current", refresh_interval_seconds: 60 };
let saved = { ...defaults };
const account = (id, active = false) => ({ id, name: id, email: null, plan_type: null, auth_mode: "api_key", is_active: active, created_at: "2026-01-01T00:00:00Z", last_used_at: null });
let accounts = [account("first", true), account("second")];
let failUsage = false;
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" } },
  transformCallback: callback => { callbacks.set(++callbackId, callback); return callbackId; },
  async invoke(command, args = {}) {
    calls.push({ command, args });
    switch (command) {
      case "plugin:event|listen": subscriptions.set(args.handler, args); return args.handler;
      case "get_runtime_preferences": return { ...saved };
      case "set_runtime_preferences": saved = { ...args.preferences }; return { ...saved };
      case "get_display_settings": return { account_switch_mode: "direct", tray_display_mode: "active_usage_text", dock_display_mode: null };
      case "list_accounts": return accounts.map(a => ({ ...a }));
      case "get_usage": if (failUsage) throw new Error("401 Unauthorized"); return { account_id: args.accountId, primary_used_percent: 25, secondary_used_percent: 50, error: null };
      case "warmup_account": await new Promise(resolve => setTimeout(resolve, 20)); return null;
      case "get_account_usage_stats": throw new Error("401 Unauthorized");
      case "refresh_account_metadata": return accounts.find(a => a.id === args.accountId);
      case "switch_account": accounts = accounts.map(a => ({ ...a, is_active: a.id === args.accountId })); return null;
      case "rename_account": accounts = accounts.map(a => a.id === args.accountId ? { ...a, name: args.newName } : a); return null;
      case "complete_login": { const added = account("added"); accounts.push(added); return added; }
      case "export_accounts_json": return [];
      case "get_masked_account_ids": return [];
      case "get_dock_display_mode": return null;
      case "check_codex_processes": return { can_switch: true, count: 0, background_count: 0, pids: [] };
      default: return null;
    }
  },
};
const server = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
const { createRoot } = await import("react-dom/client");
const { AccountUsageStats } = await server.ssrLoadModule("/src/components/AccountUsageStats.tsx");
const { getDueAutoWarmupWindow } = await server.ssrLoadModule("/src/lib/autoWarmupPolicy.ts");
const { TimedWarmupEditor } = await server.ssrLoadModule("/src/components/TimedWarmupEditor.tsx");
const { readAccountCache, writeAccountCache, readStatsCache, writeStatsCache } = await server.ssrLoadModule("/src/lib/accountCache.ts");
const { SettingsModal } = await server.ssrLoadModule("/src/components/SettingsModal.tsx");
const { AccountTransferModal } = await server.ssrLoadModule("/src/components/AccountTransferModal.tsx");
const { useRuntimePreferences } = await server.ssrLoadModule("/src/hooks/useRuntimePreferences.ts");
const { useAccounts } = await server.ssrLoadModule("/src/hooks/useAccounts.ts");
const { default: TrayMenu } = await server.ssrLoadModule("/src/TrayMenu.tsx");
const root = createRoot(document.getElementById("root"));
const settle = async () => {
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
};
const click = async selector => { await act(async () => document.querySelector(selector).click()); await settle(); };
after(async () => { await act(async () => root.unmount()); await server.close(); dom.window.close(); });

test("settings tabs expose switches and persist disabled startup and update choices", async () => {
  saved = { ...defaults };
  function SettingsHarness() {
    const runtimePreferences = useRuntimePreferences();
    return createElement(SettingsModal, { runtimePreferences,
      updater: { enabled: true, version: "1.0.1", status: { kind: "idle" }, checkForUpdate: async () => {} },
      theme: "light", onThemeChange() {}, autoWarmupEnabled: false, autoWarmupLabel: "", onAutoWarmupChange() {}, warmupAvailable: true,
      timedWarmupEnabled: false, timedWarmupTimes: [], timedWarmupLabel: "", onTimedWarmupChange() {}, onTimedWarmupTimesChange() {}, onClose() {},
    });
  }
  await act(async () => root.render(createElement(SettingsHarness)));
  await settle();
  assert.equal(document.querySelectorAll('[role="tab"]').length, 3);
  assert.equal(document.querySelector('#app-autostart').getAttribute('aria-checked'), 'true');
  await click('#app-autostart');
  assert.equal(saved.autostart_enabled, false);
  await click('#settings-accounts');
  assert.equal(document.querySelector('#refresh-scope').value, 'current');
  assert.equal(document.querySelector('#refresh-interval').value, '60');
  assert.equal(document.querySelector('#auto-warmup').getAttribute('role'), 'switch');
  await click('#settings-updates');
  await click('#automatic-update-checks');
  assert.equal(saved.automatic_update_checks, false);
  assert.match(document.body.textContent, /已关闭自动检查/);
  assert.ok([...document.querySelectorAll('button')].find(button => button.textContent === '检查更新' && !button.disabled));
  await act(async () => root.render(null));
  await act(async () => root.render(createElement(SettingsHarness)));
  await settle();
  assert.equal(document.querySelector('#app-autostart').getAttribute('aria-checked'), 'false');
  await click('#settings-updates');
  assert.equal(document.querySelector('#automatic-update-checks').getAttribute('aria-checked'), 'false');
});

test("one transfer dialog switches import and export without importing or refreshing accounts", async () => {
  calls.length = 0;
  await act(async () => root.render(createElement(AccountTransferModal, { open: true, mode: "import", accountId: null, onClose() {}, onImported() {} })));
  await settle();
  assert.equal(document.querySelector('#transfer-import-tab').getAttribute('aria-selected'), 'true');
  await click('#transfer-export-tab');
  assert.equal(document.querySelector('#transfer-export-tab').getAttribute('aria-selected'), 'true');
  assert.ok(calls.some(call => call.command === 'export_accounts_json'));
  await click('#transfer-import-tab');
  assert.equal(document.querySelector('#transfer-import-tab').getAttribute('aria-selected'), 'true');
  assert.ok(!calls.some(call => call.command === 'get_usage' || call.command.startsWith('import_accounts')));
});

test("automatic current refresh follows switching, rename makes no usage requests, and login only refreshes the added account", async () => {
  accounts = [account("first", true), account("second")];
  localStorage.removeItem("codex-switcher-account-display-cache-v1");
  calls.length = 0;
  let controller;
  function AccountHarness({ scope = "current" }) { controller = useAccounts({ ...defaults, refresh_scope: scope }, true); return null; }
  await act(async () => root.render(createElement(AccountHarness)));
  await settle();
  assert.deepEqual(calls.filter(call => call.command === 'get_usage').map(call => call.args.accountId), ['first', 'second']);
  calls.length = 0;
  await act(async () => controller.switchAccount('second'));
  await settle();
  assert.deepEqual(calls.filter(call => call.command === 'get_usage').map(call => call.args.accountId), ['second']);
  calls.length = 0;
  await act(async () => controller.renameAccount('first', 'renamed'));
  await settle();
  assert.equal(calls.filter(call => call.command === 'get_usage').length, 0);
  await act(async () => controller.completeOAuthLogin());
  await settle();
  assert.deepEqual(calls.filter(call => call.command === 'get_usage').map(call => call.args.accountId), ['added']);
  calls.length = 0;
  await act(async () => root.render(createElement(AccountHarness, { scope: "all" })));
  await settle();
  assert.deepEqual(calls.filter(call => call.command === 'get_usage').map(call => call.args.accountId).sort(), ['added', 'first', 'second']);
});

test("tray opening follows the selected refresh scope and metadata-only changes do not fetch usage", async () => {
  accounts = [account("first", true), account("second")];
  saved = { ...defaults };
  calls.length = 0;
  await act(async () => root.render(createElement(TrayMenu)));
  await settle();
  assert.equal(calls.filter(call => call.command === 'get_usage').length, 0);
  const emit = async event => {
    await act(async () => {
      for (const [id, subscription] of subscriptions) {
        if (subscription.event === event) callbacks.get(id)({ event, id, payload: null });
      }
    });
    await settle();
  };
  await emit('tray-refresh');
  assert.deepEqual(calls.filter(call => call.command === 'get_usage').map(call => call.args.accountId), ['first']);
  calls.length = 0;
  await emit('accounts-changed');
  assert.equal(calls.filter(call => call.command === 'get_usage').length, 0);
  saved.refresh_scope = 'all';
  await emit('tray-refresh');
  assert.deepEqual(calls.filter(call => call.command === 'get_usage').map(call => call.args.accountId).sort(), ['first', 'second']);
});


test("scheduled editor edits, adds, rejects duplicates and deletes without losing saved times", async () => {
  let savedTimes = ["08:00", "18:00"];
  function EditorHarness() {
    const [times, setTimes] = useState(savedTimes);
    return createElement(TimedWarmupEditor, { times, onChange(next) { savedTimes = next; setTimes(next); }, onClose() {} });
  }
  await act(async () => root.render(createElement(EditorHarness)));
  const input = async (selector, value) => {
    await act(async () => {
      const element = document.querySelector(selector);
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value);
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
      element.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  };
  const row = 'input[aria-label="定时预热 1"]';
  const draft = 'input[aria-label="新增预热时间"]';
  await input(row, '09:00');
  assert.deepEqual(savedTimes, ['09:00', '18:00']);
  await input(draft, '12:00');
  await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === '添加').click());
  assert.deepEqual(savedTimes, ['09:00', '12:00', '18:00']);
  await input(row, '18:00');
  assert.deepEqual(savedTimes, ['09:00', '12:00', '18:00']);
  assert.ok(document.querySelector('[role="alert"]'));
  await input(row, '10:00');
  assert.deepEqual(savedTimes, ['10:00', '12:00', '18:00']);
  await click('button[aria-label="删除 12:00"]');
  assert.deepEqual(savedTimes, ['10:00', '18:00']);
});

test("display cache whitelists fields and restores values through expired authorization and remount", async () => {
  await act(async () => root.render(null));
  localStorage.removeItem('codex-switcher-account-display-cache-v1');
  accounts = [account('first', true), account('second')];
  let controller;
  function Harness() { controller = useAccounts(defaults, true); return null; }
  failUsage = false;
  await act(async () => root.render(createElement(Harness)));
  await settle();
  const timestamp = controller.accounts[0].usage.recorded_at;
  assert.equal(controller.accounts[1].usage.primary_used_percent, 25);
  writeAccountCache(controller.accounts.map(a => ({ ...a, access_token: 'secret', usage: { ...a.usage, token: 'secret' } })));
  assert.ok(!localStorage.getItem('codex-switcher-account-display-cache-v1').includes('secret'));
  await act(async () => root.render(null));
  calls.length = 0;
  failUsage = true;
  await act(async () => root.render(createElement(Harness)));
  assert.equal(controller.accounts[0].usage.primary_used_percent, 25);
  assert.equal(controller.accounts[0].usageLoading, false);
  await settle();
  assert.deepEqual(calls.filter(c => c.command === 'get_usage').map(c => c.args.accountId), ['first']);
  assert.equal(controller.accounts[0].usage.primary_used_percent, 25);
  assert.equal(controller.accounts[0].usage.recorded_at, timestamp);
  assert.match(controller.accounts[0].usage.error, /401/);
  assert.equal(readAccountCache()[0].usage.primary_used_percent, 25);
  failUsage = false;
  await act(async () => controller.refreshSingleUsage('first'));
  assert.equal(controller.accounts[0].usage.from_cache, false);
  assert.equal(controller.accounts[0].usage.error, null);
  accounts = [account('first', true)];
  await act(async () => controller.loadAccounts(true));
  assert.deepEqual(readAccountCache().map(a => a.id), ['first']);
  const stats = { account_id: 'first', available: true, error: null, summary: { lifetime_tokens: 1234 }, activity: { total_threads: 12 }, daily: [], top_invocations: [], reset_credits: { remaining: 5 }, token: 'secret' };
  writeStatsCache(stats);
  assert.equal(readStatsCache('first').summary.lifetime_tokens, 1234);
  assert.equal(readStatsCache('first').reset_credits, null);
  assert.equal(readStatsCache('second'), null);
  writeStatsCache({ ...stats, available: false, error: '401' });
  assert.equal(readStatsCache('first').summary.lifetime_tokens, 1234);
  assert.ok(!localStorage.getItem('codex-switcher-account-stats-cache-v1').includes('secret'));
});


test("statistics dialog keeps cached values when authorization expires", async () => {
  await act(async () => root.render(createElement(AccountUsageStats, { accountId: 'first', accountName: 'first', enabled: true, open: true, onClose() {} })));
  assert.match(document.body.textContent, /1.2K/);
  await settle();
  assert.match(document.body.textContent, /1.2K/);
  assert.equal(document.querySelectorAll('.animate-pulse').length, 0);
});

test("concurrent warmups for one account issue only one backend request", async () => {
  let controller;
  function Harness() { controller = useAccounts(defaults, true); return null; }
  await act(async () => root.render(createElement(Harness)));
  await settle();
  calls.length = 0;
  await act(async () => Promise.all([controller.warmupAccount('first'), controller.warmupAccount('first')]));
  assert.equal(calls.filter(c => c.command === 'warmup_account').length, 1);
});

test("automatic warmup requires fresh quota, skips full weeks and remembers the reset window", () => {
  const now = Date.now();
  const usage = { account_id: 'first', primary_used_percent: 0, primary_window_minutes: 300, primary_resets_at: Math.floor(now / 1000) + 300 * 60, secondary_used_percent: 20, error: null };
  const due = getDueAutoWarmupWindow(usage, undefined, now);
  assert.equal(due.kind, 'session');
  assert.equal(getDueAutoWarmupWindow({ ...usage, from_cache: true }, undefined, now), null);
  assert.equal(getDueAutoWarmupWindow({ ...usage, secondary_used_percent: 100 }, undefined, now), null);
  assert.equal(getDueAutoWarmupWindow({ ...usage, primary_resets_at: usage.primary_resets_at - 6 * 60 }, undefined, now), null);
  assert.equal(getDueAutoWarmupWindow(usage, { lastSuccessfulWarmupAt: now - 30_000 }, now), null);
  assert.equal(getDueAutoWarmupWindow(usage, { lastAutoWindowKey: `${due.kind}:${due.windowMinutes}:${due.resetsAt}` }, now), null);
});
