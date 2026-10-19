import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement, act } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true });
const calls = [];
let saved = { server: "https://example.com/dav/", username: "public-test", directory: "/", sync_accounts: true, sync_settings: true, auto_sync: false };
const emptyChanges = () => ({ added: [], updated: [], deleted: [], settings: [] });
const plan = (overrides = {}) => ({ mode: "merge", choice: null, token: "preview-v1", first_sync: false, cloud_missing: false, local_accounts: 1, cloud_accounts: 2, to_local: emptyChanges(), to_cloud: emptyChanges(), conflicts: [], ...overrides });
const completed = (overrides = {}) => ({ conflicts: [], bytes: 321, uploaded: true, synced_at: "2026-10-16T01:00:00Z", ui: null, needs_confirmation: false, preview: plan(), recovery_path: null, ...overrides });
let syncReply = completed();
let listedAccounts = [];
window.__TAURI_INTERNALS__ = {
  async invoke(command, args = {}) {
    calls.push({ command, args });
    if (command === "get_webdav_config") return { config: { ...saved }, password_saved: true };
    if (command === "save_webdav_config") { saved = { ...args.config }; return { config: { ...saved }, password_saved: true }; }
    if (command === "list_webdav_directories") return args.directory === "/" ? [{ name: "中文 & folder", path: "/中文 & folder/" }] : [];
    if (command === "sync_webdav") return typeof syncReply === "function" ? syncReply(args) : syncReply;
    if (command === "list_accounts") return listedAccounts;
    throw new Error(`Unexpected command ${command}`);
  },
};
const server = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: "custom" });
const { WebDavSettings } = await server.ssrLoadModule("/src/components/WebDavSettings.tsx");
const service = await server.ssrLoadModule("/src/lib/webdav.ts");
const quotaSync = await server.ssrLoadModule("/src/lib/accountQuotaSync.ts");
const accountCache = await server.ssrLoadModule("/src/lib/accountCache.ts");
const { AccountCard } = await server.ssrLoadModule("/src/components/AccountCard.tsx");
const { createRoot } = await import("react-dom/client");
const root = createRoot(document.getElementById("root"));
const settle = async () => { for (let n = 0; n < 3; n++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); };
const button = text => [...document.querySelectorAll("button")].find(b => b.textContent === text);
async function click(text) { assert.ok(button(text), `Missing button ${text}`); await act(async () => button(text).click()); await settle(); }
async function mount() { await act(async () => root.render(null)); await act(async () => root.render(createElement(WebDavSettings))); await settle(); }
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
  await click("双向同步");
  assert.equal(saved.sync_accounts, false); assert.equal(saved.sync_settings, true);
  const payload = calls.filter(c => c.command === "sync_webdav").at(-1).args;
  assert.deepEqual(Object.keys(payload.ui).sort(), ["auto_warmup", "language", "theme", "timed_warmup", "warmup_times"]);
  assert.doesNotMatch(JSON.stringify(payload), /password|server|username|token/);
  assert.match(document.body.textContent, /0.3 KB/);
  await act(async () => document.querySelectorAll('input[type="checkbox"]')[1].click()); await settle();
  assert.equal(button("双向同步").disabled, true);
});

test("conflict pauses automatic sync and explicit retry forwards the chosen side", async () => {
  saved = { ...saved, sync_accounts: true, sync_settings: true };
  await mount();
  syncReply = completed({ conflicts: ["name"], needs_confirmation: true, preview: plan({ conflicts: [{ account: "测试账号", field: "name" }] }), synced_at: "", ui: null });
  await click("双向同步");
  assert.equal(service.davState.paused, true);
  assert.match(document.body.textContent, /同步已暂停/);
  assert.match(document.body.textContent, /测试账号：名称/);
  assert.equal(button("确认双向同步").disabled, true);
  syncReply = completed({ needs_confirmation: true, synced_at: "", preview: plan({ choice: "remote", token: "resolved-v2", conflicts: [{ account: "测试账号", field: "name" }] }) });
  await click("冲突采用云端");
  assert.equal(calls.filter(c => c.command === "sync_webdav").at(-1).args.choice, "remote");
  assert.equal(service.davState.paused, true);
  syncReply = completed({ ui: { theme: "dark", language: "zh-CN", auto_warmup: true, timed_warmup: true, warmup_times: ["09:30"] } });
  await click("确认双向同步");
  assert.equal(calls.filter(c => c.command === "sync_webdav").at(-1).args.confirmation, "resolved-v2");
  assert.equal(service.davState.paused, false);
  assert.equal(localStorage.getItem("codex-switcher-theme"), "dark");
  assert.equal(localStorage.getItem("codex-switcher-auto-warmup-all"), "true");
  assert.equal(localStorage.getItem("codex-switcher-timed-warmup-times"), '["09:30"]');
});

test("first sync previews upload and download separately without applying settings before confirmation", async () => {
  await mount();
  const before = localStorage.getItem("codex-switcher-theme");
  syncReply = completed({ synced_at: "", needs_confirmation: true, preview: plan({ first_sync: true, to_local: { ...emptyChanges(), added: ["云端账号"] }, to_cloud: { ...emptyChanges(), updated: ["本机账号"] } }), ui: { theme: before === "dark" ? "light" : "dark" } });
  await click("双向同步");
  assert.equal(localStorage.getItem("codex-switcher-theme"), before);
  assert.match(document.body.textContent, /从云端更新本机: 账号新增 1/);
  assert.match(document.body.textContent, /从本机更新云端: 账号新增 0、修改 1/);
  assert.match(document.body.textContent, /云端账号/);
  const count = calls.filter(c => c.command === "sync_webdav").length;
  await click("取消");
  assert.equal(calls.filter(c => c.command === "sync_webdav").length, count);
  assert.equal(service.davState.paused, true);
  assert.equal(document.querySelector('[aria-label="同步预览"]'), null);
});

test("one-way replacements are secondary actions with scoped deletion preview and recovery result", async () => {
  for (const mode of ["upload", "download"]) {
    await act(async () => service.resumeDavSync());
    saved = { ...saved, sync_accounts: true, sync_settings: false };
    await mount();
    const title = mode === "upload" ? "用本机覆盖云端" : "用云端覆盖本机";
    assert.equal(button(title), undefined);
    await click("更多操作");
    const replacement = plan({ mode, to_local: mode === "download" ? { ...emptyChanges(), deleted: ["本机独有账号"] } : emptyChanges(), to_cloud: mode === "upload" ? { ...emptyChanges(), deleted: ["云端独有账号"] } : emptyChanges() });
    syncReply = completed({ synced_at: "", needs_confirmation: true, preview: replacement });
    await click(title);
    assert.equal(calls.filter(c => c.command === "sync_webdav").at(-1).args.mode, mode);
    assert.equal(calls.filter(c => c.command === "sync_webdav").at(-1).args.confirmation, null);
    assert.match(document.body.textContent, /目标端独有的所选内容也会被替换或删除/);
    assert.equal(saved.sync_settings, false);
    syncReply = completed({ preview: replacement, recovery_path: "C:\\public-test\\webdav-recovery.json" });
    await click(`确认${title}`);
    assert.equal(calls.filter(c => c.command === "sync_webdav").at(-1).args.confirmation, "preview-v1");
    assert.match(document.body.textContent, /已保存操作前的恢复副本/);
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
