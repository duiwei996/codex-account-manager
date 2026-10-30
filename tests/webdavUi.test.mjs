import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement, Fragment, act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
const calls = [];
let saved = { server: "https://example.com/dav/", username: "public-test", directory: "/", sync_accounts: true, sync_settings: true, auto_sync: false };
const emptyChanges = () => ({ added: [], updated: [], deleted: [], settings: [] });
const plan = (overrides = {}) => ({ mode: "merge", choice: null, token: "preview-v1", first_sync: false, cloud_missing: false, local_accounts: 1, cloud_accounts: 2, to_local: emptyChanges(), to_cloud: emptyChanges(), restored_accounts: [], conflicts: [], ...overrides });
const completed = (overrides = {}) => ({ conflicts: [], bytes: 321, uploaded: true, synced_at: "2026-10-16T01:00:00Z", ui: null, needs_confirmation: false, preview: plan(), recovery_path: null, ...overrides });
let syncReply = completed();
let listedAccounts = [];
let configError = null;
window.__TAURI_INTERNALS__ = {
  async invoke(command, args = {}) {
    calls.push({ command, args });
    if (command === "get_webdav_config") {
      if (configError) throw configError;
      return { config: { ...saved }, password_saved: true };
    }
    if (command === "save_webdav_config") { saved = { ...args.config }; return { config: { ...saved }, password_saved: true }; }
    if (command === "list_webdav_directories") return args.directory === "/" ? [{ name: "中文 & folder", path: "/中文 & folder/" }] : [];
    if (command === "sync_webdav") return typeof syncReply === "function" ? syncReply(args) : syncReply;
    if (command === "list_accounts") return listedAccounts;
    throw new Error(`Unexpected command ${command}`);
  },
};
const server = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
const { WebDavSettings } = await server.ssrLoadModule("/src/components/WebDavSettings.tsx");
const { WebDavSyncDialog } = await server.ssrLoadModule("/src/components/WebDavSyncDialog.tsx");
const { WebDavSyncButton } = await server.ssrLoadModule("/src/components/WebDavSyncButton.tsx");
const service = await server.ssrLoadModule("/src/lib/webdav.ts");
const quotaSync = await server.ssrLoadModule("/src/lib/accountQuotaSync.ts");
const accountCache = await server.ssrLoadModule("/src/lib/accountCache.ts");
const { AccountCard } = await server.ssrLoadModule("/src/components/AccountCard.tsx");
const { createRoot } = await import("react-dom/client");
const root = createRoot(document.getElementById("root"));
const settle = async () => { for (let n = 0; n < 3; n++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); };
const button = text => [...document.querySelectorAll("button")].find(b => b.textContent === text);
async function click(text) { assert.ok(button(text), `Missing button ${text}`); await act(async () => button(text).click()); await settle(); }
async function mount() { await act(async () => root.render(null)); await act(async () => root.render(createElement(Fragment, null, createElement(WebDavSettings), createElement(WebDavSyncDialog)))); await settle(); }
after(async () => { await act(async () => root.unmount()); await server.close(); dom.window.close(); });

test("directory browsing enters subfolders, goes up and saves only the chosen path", async () => {
  await mount();
  assert.equal(document.querySelectorAll('input[type="password"]').length, 1);
  assert.doesNotMatch(document.body.textContent, /同步加密密码/);
  await click("选择目录");
  assert.equal(calls.at(-1).args.directory, "/");
  await click("📁 中文 & folder");
  assert.equal(calls.at(-1).args.directory, "/中文 & folder/");
  assert.match(document.body.textContent, /没有子目录/);
  await click("返回上级");
  assert.equal(calls.at(-1).args.directory, "/");
  await click("📁 中文 & folder");
  await click("选择当前目录");
  assert.equal(document.querySelector('[aria-label="WebDAV 目录选择"]'), null);
  await click("保存设置");
  const save = calls.filter(c => c.command === "save_webdav_config").at(-1);
  assert.equal(save.args.config.directory, "/中文 & folder/");
  assert.equal(save.args.password, null);
  assert.equal(localStorage.getItem("webdav-password"), null);
});

test("two independent options, minimal settings payload and visible actual size", async () => {
  await mount();
  const options = document.querySelectorAll('input[type="checkbox"]');
  assert.equal(options.length, 3);
  await act(async () => options[0].click()); await settle();
  await click("立即同步");
  assert.equal(saved.sync_accounts, false); assert.equal(saved.sync_settings, true);
  const payload = calls.filter(c => c.command === "sync_webdav").at(-1).args;
  assert.deepEqual(Object.keys(payload.ui).sort(), ["auto_warmup", "language", "theme", "timed_warmup", "warmup_times"]);
  assert.doesNotMatch(JSON.stringify(payload), /password|server|username|token/);
  assert.match(document.body.textContent, /0.3 KB/);
  await act(async () => document.querySelectorAll('input[type="checkbox"]')[1].click()); await settle();
  assert.equal(button("立即同步").disabled, true);
});







test("automatic sync retries both configuration and sync failures on the next scheduled check", async () => {
  const timers = { timeout: window.setTimeout, interval: window.setInterval };
  let initial, nextCheck, dispose;
  window.setTimeout = callback => { initial = callback; return -1; };
  window.setInterval = callback => { nextCheck = callback; return -2; };
  try {
    for (const failure of ["sync", "config"]) {
      await act(async () => service.resumeDavSync());
      saved = { ...saved, auto_sync: true };
      configError = failure === "config" ? new Error("temporary configuration failure") : null;
      syncReply = () => { throw new Error("temporary sync failure"); };
      dispose = service.startDavAutoSync();
      await act(async () => initial());
      await settle();
      assert.match(service.davState.error, /temporary/);
      assert.equal(service.davState.paused, false);
      const attempts = calls.filter(c => c.command === "sync_webdav").length;
      configError = null;
      syncReply = completed();
      await act(async () => nextCheck());
      await settle();
      assert.equal(calls.filter(c => c.command === "sync_webdav").length, attempts + 1);
      assert.equal(service.davState.error, "");
      assert.equal(service.davState.paused, false);
      dispose();
      dispose = null;
    }
  } finally {
    dispose?.();
    window.setTimeout = timers.timeout;
    window.setInterval = timers.interval;
    configError = null;
    saved = { ...saved, auto_sync: false };
  }
});



test("editing one preference during sync preserves it and still applies independent cloud preferences", async () => {
  await act(async () => { localStorage.clear(); service.resumeDavSync(); });
  let finish;
  syncReply = () => new Promise(resolve => { finish = resolve; });
  let running;
  await act(async () => { running = service.runDavSync(); });
  await settle();
  assert.equal(typeof finish,"function");
  await act(async () => localStorage.setItem("codex-switcher-theme","dark"));
  await act(async () => {
    finish(completed({ ui: { theme: "light", auto_warmup: true } }));
    await running;
  });
  assert.equal(localStorage.getItem("codex-switcher-theme"),"dark");
  assert.equal(localStorage.getItem("codex-switcher-auto-warmup-all"),"true");
});

const cachedAccount = id => ({ id,name:"Cached account",email:"cache@example.com",plan_type:"plus",auth_mode:"chat_g_p_t",is_active:false,created_at:"2026-10-01T00:00:00Z",last_used_at:null,subscription_expires_at:"2030-12-01T00:00:00Z",metadata_recorded_at:"2026-10-19T10:00:00Z" });
const quota = (id, used = 25, stamp = "2026-10-19T10:00:00Z") => ({ account_id:id,recorded_at:stamp,primary_used_percent:used,primary_window_minutes:300,primary_resets_at:1900000000,secondary_used_percent:50,secondary_window_minutes:10080,secondary_resets_at:1900100000,has_credits:true,unlimited_credits:false,credits_balance:"15",plan_type:"plus",error:null });
const resets = credits => ({ available_count:credits.length,next_expires_at:credits[0]?.expires_at ?? null,credits:credits.map(c=>({ ...c,status:"available",reset_type:"reset",granted_at:null,redeem_started_at:null,redeemed_at:null,description:null })) });

test("account cache payload includes only quota, expiry and reset-credit observations", async () => {
  await act(async () => { root.render(null); localStorage.clear(); });
  const account = cachedAccount("source");
  accountCache.writeAccountCache([{ ...account,usage:quota(account.id),access_token:"private-token" }]);
  accountCache.writeResetCreditsCache(account.id,{ ...resets([{id:"credit-1",expires_at:"2030-12-01T00:00:00Z",title:"Reset"}]),credits:[{id:"credit-1",status:"AVAILABLE",expires_at:"2030-12-01T00:00:00Z",title:"Reset"}] },"2026-10-19T10:00:00Z");
  assert.equal(accountCache.readResetCreditsCache(account.id).data.available_count,1);
  accountCache.writeStatsCache({ account_id:account.id,available:true,error:null,summary:{ lifetime_tokens:12345 },activity:{ total_threads:42 },daily:[{date:"2026-10-19",tokens:123}],top_invocations:[{kind:"skill",display_name:"private-stat",usage_count:5}],reset_credits:resets([{id:"credit-1",expires_at:"2030-12-01T00:00:00Z",title:"Reset"}]),reset_credits_recorded_at:"2026-10-19T10:00:00Z" });
  const payload = quotaSync.collectAccountSyncCaches();
  assert.deepEqual(Object.keys(payload.source).sort(),["metadata","resets","usage"]);
  assert.equal(payload.source.usage.primary_used_percent,25);
  assert.equal(payload.source.resets.credits.length,1);
  assert.doesNotMatch(JSON.stringify(payload),/lifetime_tokens|daily|top_invocations|private-stat|private-token|account_id|is_active/);
  listedAccounts = [cachedAccount("destination")];
  quotaSync.applyAccountSyncCaches(listedAccounts,{ destination:payload.source });
  assert.equal(accountCache.readAccountCache()[0].id,"destination");
  assert.equal(accountCache.readAccountCache()[0].usage.account_id,"destination");
  assert.equal(accountCache.readAccountCache()[0].usage.from_cache,true);
  assert.equal(accountCache.readResetCreditsCache("destination").data.available_count,1);
  assert.equal(accountCache.readStatsCache("destination"),null);
});

test("older cloud quotas and resets cannot overwrite a newer local query, including a zero result", async () => {
  const account = cachedAccount("destination");
  const old = quotaSync.collectAccountSyncCaches().destination;
  accountCache.writeAccountCache([{ ...account,metadata_recorded_at:"2026-10-19T12:00:00Z",subscription_expires_at:"2031-01-01T00:00:00Z",usage:quota(account.id,7,"2026-10-19T12:00:00Z") }]);
  accountCache.writeResetCreditsCache(account.id,resets([]),"2026-10-19T12:00:00Z");
  quotaSync.applyAccountSyncCaches([account],{ destination:old });
  assert.equal(accountCache.readAccountCache()[0].usage.primary_used_percent,7);
  assert.equal(accountCache.readAccountCache()[0].subscription_expires_at,"2031-01-01T00:00:00Z");
  assert.equal(accountCache.readResetCreditsCache(account.id).data.available_count,0);
  assert.deepEqual(quotaSync.collectAccountSyncCaches().destination.resets.credits,[]);
  // An older React persistence effect must not clobber the newer cache either.
  accountCache.writeAccountCache([{ ...account,usage:quota(account.id,90) }]);
  assert.equal(accountCache.readAccountCache()[0].usage.primary_used_percent,7);
});

test("quota caches are applied only after confirmed sync, and refresh the saved destination IDs", async () => {
  await act(async () => service.resumeDavSync());
  const cache = quotaSync.collectAccountSyncCaches().destination;
  const before = accountCache.readAccountCache()[0].usage.primary_used_percent;
  syncReply = completed({ needs_confirmation:true,synced_at:"",account_caches:{ destination:{ ...cache,usage:{ ...cache.usage,primary_used_percent:80,recorded_at:"2026-10-19T13:00:00Z" } } } });
  await act(async () => service.runDavSync());
  assert.equal(accountCache.readAccountCache()[0].usage.primary_used_percent,before);
  assert.ok(calls.filter(c=>c.command==="sync_webdav").at(-1).args.accountCaches.destination);
  syncReply = { ...syncReply,needs_confirmation:false,synced_at:"2026-10-19T13:00:00Z" };
  await act(async () => service.runDavSync({ confirmation:"preview-v1" }));
  assert.equal(accountCache.readAccountCache()[0].usage.primary_used_percent,80);
});

test("reset-credit cache survives offline querying and expiry reduces the visible count", async () => {
  await act(async () => { root.render(null); localStorage.clear(); });
  const account = cachedAccount("offline");
  const expiry = new Date(Date.now()+2000).toISOString();
  accountCache.writeResetCreditsCache(account.id,resets([{id:"expiring",expires_at:expiry,title:"Soon"},{id:"persistent",expires_at:null,title:"No expiry"}]),new Date().toISOString());
  await act(async () => root.render(createElement(AccountCard,{ account,onSwitch(){},onWarmup:async()=>{},onDelete(){},onExport(){},onRefresh:async()=>{},onRename:async()=>{} })));
  await settle();
  assert.match(document.body.textContent,/2 次重置/);
  await act(async () => { await new Promise(resolve=>setTimeout(resolve,2100)); });
  assert.match(document.body.textContent,/1 次重置/);
  assert.equal(accountCache.readResetCreditsCache(account.id).data.available_count,1);
});


test("cloud changes show one whole-copy dialog and one choice confirms immediately", async () => {
  await act(async () => service.resumeDavSync());
  await mount();
  assert.doesNotMatch(document.body.textContent, /按上次成功同步的版本比较|更新时间保留较新|不传播单边删除/);
  syncReply = completed({ needs_confirmation: true, synced_at: "", preview: plan() });
  await click("立即同步");
  assert.ok(document.querySelector('dialog[open]'));
  assert.ok(button("使用本地"));
  assert.ok(button("使用云端"));
  syncReply = completed();
  await click("使用云端");
  const args = calls.filter(c => c.command === "sync_webdav").at(-1).args;
  assert.equal(args.choice, "remote");
  assert.equal(args.confirmation, "preview-v1");
  assert.equal(document.querySelector('dialog'), null);
  assert.equal(service.davState.paused, false);
});

test("automatic cloud change prompts outside settings, cancel writes nothing and blocks repeat prompts", async () => {
  await act(async () => { service.resumeDavSync(); root.render(createElement(WebDavSyncDialog)); });
  syncReply = completed({ needs_confirmation: true, synced_at: "", preview: plan() });
  await act(async () => service.runDavSync({ automatic: true }));
  assert.ok(document.querySelector('dialog[open]'));
  const before = calls.filter(c => c.command === "sync_webdav").length;
  await click("取消");
  assert.equal(calls.filter(c => c.command === "sync_webdav").length, before);
  assert.equal(service.davState.paused, true);
  assert.equal(document.querySelector('dialog'), null);
});

test("changed confirmation data keeps the choice dialog open for a fresh decision", async () => {
  await act(async () => service.resumeDavSync());
  await mount();
  syncReply = completed({ needs_confirmation: true, synced_at: "", preview: plan() });
  await click("立即同步");
  syncReply = completed({ needs_confirmation: true, synced_at: "", preview: plan({ token: "changed-cloud" }) });
  await click("使用本地");
  assert.ok(document.querySelector('dialog[open]'));
  assert.equal(service.davState.paused, true);
  syncReply = completed();
  await click("使用本地");
  assert.equal(calls.filter(c => c.command === "sync_webdav").at(-1).args.confirmation, "changed-cloud");
});

test("choosing cloud replaces newer local caches with the chosen copy", async () => {
  const account = cachedAccount("chosen-cloud");
  accountCache.writeAccountCache([{ ...account, usage: quota(account.id, 7, "2026-10-19T12:00:00Z") }]);
  quotaSync.replaceAccountSyncCaches([account], { [account.id]: { usage: { ...quota(account.id, 90, "2026-10-19T10:00:00Z") } } });
  assert.equal(accountCache.readAccountCache()[0].usage.primary_used_percent, 90);
  quotaSync.replaceAccountSyncCaches([account], {});
  assert.equal(accountCache.readAccountCache()[0].usage, undefined);
});


test("sync interval defaults to thirty minutes and can be saved", async () => {
  await act(async () => service.resumeDavSync());
  syncReply = completed();
  await mount();
  const input = document.querySelector('input[aria-label="自动同步间隔（分钟）"]');
  assert.equal(input.value, "30");
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, "45");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await click("保存设置");
  assert.equal(saved.auto_sync_interval_minutes, 45);
});

test("automatic timer follows the saved interval and reconfigures without restarting", async () => {
  const timers = { timeout: window.setTimeout, interval: window.setInterval, clear: window.clearInterval };
  const delays = [];
  let dispose;
  window.setTimeout = () => -1;
  window.setInterval = (callback, delay) => { delays.push(delay); return -2; };
  window.clearInterval = () => {};
  try {
    saved = { ...saved, auto_sync_interval_minutes: 45 };
    dispose = service.startDavAutoSync();
    await act(async () => { await Promise.resolve(); });
    assert.equal(delays[0], 30 * 60_000);
    assert.equal(delays.at(-1), 45 * 60_000);
    saved = { ...saved, auto_sync_interval_minutes: 120 };
    await act(async () => window.dispatchEvent(new Event(service.DAV_CONFIG_CHANGED_EVENT)));
    assert.equal(delays.at(-1), 120 * 60_000);
  } finally {
    dispose?.();
    window.setTimeout = timers.timeout;
    window.setInterval = timers.interval;
    window.clearInterval = timers.clear;
  }
});


test("manual replacements show the chosen direction and require confirmation", async () => {
  for (const [mode, title] of [["upload", "本地覆盖云端"], ["download", "云端覆盖本地"]]) {
    await act(async () => service.resumeDavSync());
    await mount();
    syncReply = completed({ needs_confirmation: true, synced_at: "", preview: plan({ mode }) });
    await click(title);
    const first = calls.filter(c => c.command === "sync_webdav").at(-1).args;
    assert.equal(first.mode, mode);
    assert.equal(first.confirmation, null);
    assert.match(document.querySelector("dialog").textContent, new RegExp(`确认${title}`));
    assert.ok(button("确认覆盖"));
    assert.equal(button("使用本地"), undefined);
    syncReply = completed({ preview: plan({ mode }) });
    await click("确认覆盖");
    const confirmed = calls.filter(c => c.command === "sync_webdav").at(-1).args;
    assert.equal(confirmed.mode, mode);
    assert.equal(confirmed.confirmation, "preview-v1");
    assert.equal(confirmed.choice, null);
  }
});


test("header sync runs immediately, shows a sync icon and reuses cloud choice", async () => {
  let settings = 0;
  saved = { ...saved, server: "https://example.com/dav/", sync_accounts: true };
  syncReply = completed({ needs_confirmation: true, synced_at: "", preview: plan() });
  await act(async () => {
    service.resumeDavSync();
    root.render(createElement(Fragment, null, createElement(WebDavSyncButton, { onOpenSettings: () => settings++ }), createElement(WebDavSyncDialog)));
  });
  const button = document.querySelector('button[aria-label="立即同步"]');
  assert.ok(button.querySelector("svg"));
  assert.equal(button.textContent, "");
  const before = calls.filter(c => c.command === "sync_webdav").length;
  await act(async () => button.click());
  await settle();
  assert.equal(calls.filter(c => c.command === "sync_webdav").length, before + 1);
  assert.ok(document.querySelector("dialog[open]"));
  assert.equal(settings, 0);
  await click("取消");
});

test("header sync opens configuration if WebDAV is not configured", async () => {
  let settings = 0;
  saved = { ...saved, server: "" };
  await act(async () => { service.resumeDavSync(); root.render(createElement(WebDavSyncButton, { onOpenSettings: () => settings++ })); });
  const before = calls.filter(c => c.command === "sync_webdav").length;
  await act(async () => document.querySelector('button[aria-label="立即同步"]').click());
  await settle();
  assert.equal(settings, 1);
  assert.equal(calls.filter(c => c.command === "sync_webdav").length, before);
});


test("sync completion never displays legacy recovery-copy details", async () => {
  saved = { ...saved, server: "https://example.com/dav/", sync_accounts: true };
  await act(async () => service.resumeDavSync());
  await mount();
  syncReply = completed({ recovery_path: "C:/private/legacy-recovery.json" });
  await click("立即同步");
  assert.doesNotMatch(document.body.textContent, /legacy-recovery|恢复副本/);
});


test("manual sync reports success and failure, but pending choices and background runs stay quiet", async () => {
  const notices = [];
  const listener = event => notices.push(event.detail);
  window.addEventListener(service.DAV_NOTICE_EVENT, listener);
  try {
    syncReply = completed();
    await act(async () => service.runDavSync());
    assert.match(notices.at(-1).message, /同步成功/);
    assert.equal(notices.at(-1).isError, false);
    syncReply = () => { throw new Error("network unavailable"); };
    await act(async () => service.runDavSync());
    assert.match(notices.at(-1).message, /同步失败/);
    assert.equal(notices.at(-1).isError, true);
    const count = notices.length;
    syncReply = completed({ needs_confirmation: true, synced_at: "" });
    await act(async () => service.runDavSync());
    assert.equal(notices.length, count);
    syncReply = completed();
    await act(async () => service.runDavSync({ automatic: true }));
    assert.equal(notices.length, count);
  } finally { window.removeEventListener(service.DAV_NOTICE_EVENT, listener); }
});
