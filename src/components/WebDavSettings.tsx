import { useEffect, useState } from "react";
import { invokeBackend } from "../lib/platform";
import { useLocale } from "../lib/i18n";
import { DAV_STATE_EVENT, davState, defaultDavConfig, resumeDavSync, cancelDavPreview, runDavSync, type ConfigView, type DavConfig, type DavDirectory, type SyncChanges, type SyncMode } from "../lib/webdav";

export function WebDavSettings() {
  const locale = useLocale();
  const text = (zh: string, en: string) => locale === "zh-CN" ? zh : en;
  const [config, setConfig] = useState<DavConfig>(defaultDavConfig);
  const [password, setPassword] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [browser, setBrowser] = useState<{ path: string; directories: DavDirectory[] } | null>(null);
  const [sync, setSync] = useState({ ...davState });
  const [more, setMore] = useState(false);
  useEffect(() => {
    let disposed = false;
    void invokeBackend<ConfigView>("get_webdav_config").then(view => {
      if (!disposed) { setConfig(view.config); setPasswordSaved(view.password_saved); setReady(true); }
    }).catch(e => { if (!disposed) setError(String(e)); });
    const update = () => setSync({ ...davState });
    window.addEventListener(DAV_STATE_EVENT, update);
    return () => { disposed = true; window.removeEventListener(DAV_STATE_EVENT, update); };
  }, []);
  const edit = (patch: Partial<DavConfig>) => {
    if (patch.server !== undefined || patch.username !== undefined) setPasswordSaved(false);
    setConfig(prev => ({ ...prev, ...patch })); setDirty(true); setMessage(""); setError(""); setBrowser(null);
  };
  const credentials = () => ({ config, password: password !== "" ? password : passwordSaved ? null : "" });
  const save = async () => {
    const view = await invokeBackend<ConfigView>("save_webdav_config", credentials());
    setConfig(view.config); setPasswordSaved(view.password_saved); setPassword(""); setDirty(false); resumeDavSync();
  };
  const action = async (fn: () => Promise<void>) => {
    setBusy(true); setError(""); setMessage("");
    try { await fn(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const browse = (path: string) => action(async () => {
    const directories = await invokeBackend<DavDirectory[]>("list_webdav_directories", { ...credentials(), directory: path });
    setBrowser({ path, directories });
  });
  const pending = sync.result?.needs_confirmation === true;
  const disabled = !ready || busy || sync.busy;
  const input = "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 disabled:opacity-50";
  const button = "rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800 disabled:opacity-50";
  const result = sync.result;
  const plan = result?.preview;
  const modeTitle = (mode: SyncMode) => mode === "upload" ? text("用本机覆盖云端", "Replace cloud with local") : mode === "download" ? text("用云端覆盖本机", "Replace local with cloud") : text("双向同步", "Two-way sync");
  const fieldName = (key: string) => ({ name: text("名称", "Name"), hidden: text("隐藏状态", "Hidden state"), credentials: text("登录凭据", "Credentials"), account: text("账号删除或修改", "Account deletion or modification"), theme: text("外观", "Appearance"), language: text("语言", "Language"), auto_warmup: text("自动预热", "Automatic warm-up"), timed_warmup: text("定时预热", "Scheduled warm-up"), warmup_times: text("预热时间", "Warm-up times"), automatic_update_checks: text("更新检查", "Update checks"), refresh_scope: text("刷新范围", "Refresh scope"), refresh_interval_seconds: text("刷新间隔", "Refresh interval"), account_switch_mode: text("账号切换方式", "Account switch mode"), email: text("邮箱", "Email"), plan_type: text("订阅类型", "Plan type"), auth_mode: text("登录方式", "Sign-in method") }[key] ?? text("账号信息", "Account information"));
  const summary = (changes: SyncChanges) => text(`账号新增 ${changes.added.length}、修改 ${changes.updated.length}、删除 ${changes.deleted.length}；设置变化 ${changes.settings.length} 项；额度缓存更新 ${changes.cache_updated?.length ?? 0} 个`, `Accounts: ${changes.added.length} added, ${changes.updated.length} updated, ${changes.deleted.length} deleted; ${changes.settings.length} settings changed; ${changes.cache_updated?.length ?? 0} quota caches updated`);
  const details = (changes: SyncChanges) => <div className="space-y-1 text-xs text-gray-500 dark:text-gray-400">
    {changes.added.length > 0 && <p>{text("新增", "Added")}: {changes.added.join("、")}</p>}
    {changes.updated.length > 0 && <p>{text("修改", "Updated")}: {changes.updated.join("、")}</p>}
    {changes.deleted.length > 0 && <p className="text-red-600 dark:text-red-300">{text("删除", "Deleted")}: {changes.deleted.join("、")}</p>}
    {changes.settings.length > 0 && <p>{text("设置", "Settings")}: {changes.settings.map(fieldName).join("、")}</p>}
    {!!changes.cache_updated?.length && <p>{text("额度缓存", "Quota cache")}: {changes.cache_updated.join("、")}</p>}
  </div>;
  const start = (mode: SyncMode) => action(async () => { setBrowser(null); await save(); setMore(false); await runDavSync({ mode }); });
  return <div className="space-y-4 py-4 text-sm">
    <p className="text-gray-500 dark:text-gray-400">{text("双向同步：先读取云端，合并两边变化，再更新本机和云端。首次使用会先展示预览。", "Two-way sync reads the cloud, merges both sides, then updates this computer and the cloud. First use shows a preview.")}</p>
    <fieldset disabled={disabled || pending} className="space-y-3">
      <label className="block space-y-1"><span>{text("服务器地址", "Server URL")}</span><input aria-label={text("服务器地址", "Server URL")} className={input} type="url" placeholder="https://dav.example.com/dav/" value={config.server} autoComplete="off" onChange={e => edit({ server: e.target.value })} /></label>
      <label className="block space-y-1"><span>{text("用户名", "Username")}</span><input className={input} value={config.username} autoComplete="off" onChange={e => edit({ username: e.target.value })} /></label>
      <label className="block space-y-1"><span>{text("密码 / 应用密码", "Password / App password")}</span><input className={input} type="password" autoComplete="new-password" value={password} placeholder={passwordSaved ? text("已安全保存，留空保持不变", "Saved securely; leave blank to keep") : ""} onChange={e => { setPassword(e.target.value); setDirty(true); }} /></label>
      <label className="block space-y-1"><span>{text("同步目录", "Sync directory")}</span><div className="flex gap-2"><input className={input} value={config.directory} onChange={e => edit({ directory: e.target.value })} /><button type="button" disabled={!config.server} className={`${button} shrink-0`} onClick={() => void browse("/")}>{text("选择目录", "Browse")}</button></div></label>
    </fieldset>
    {browser && <div role="group" aria-label={text("WebDAV 目录选择", "WebDAV directory picker")} className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
      <p className="break-all font-mono text-xs">{browser.path}</p>
      <div className="flex flex-wrap gap-2">
        <button disabled={disabled || browser.path === "/"} className={button} onClick={() => { const parts = browser.path.split("/").filter(Boolean); parts.pop(); void browse(parts.length ? `/${parts.join("/")}/` : "/"); }}>{text("返回上级", "Up")}</button>
        <button disabled={disabled} className={button} onClick={() => { edit({ directory: browser.path }); }}>{text("选择当前目录", "Use this folder")}</button>
        <button disabled={disabled} className={button} onClick={() => setBrowser(null)}>{text("取消", "Cancel")}</button>
      </div>
      <div className="max-h-48 overflow-y-auto">
        {browser.directories.length ? browser.directories.map(dir => <button key={dir.path} disabled={disabled} className="block w-full break-all rounded-lg px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800" onClick={() => void browse(dir.path)}>📁 {dir.name}</button>) : <p className="py-3 text-gray-400">{text("没有子目录，可以选择当前目录。", "No subfolders. You can use this folder.")}</p>}
      </div>
    </div>}
    <fieldset disabled={disabled || pending} className="space-y-3">
      <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={config.sync_accounts} onChange={e => edit({ sync_accounts: e.target.checked })} /><span>{text("同步账号", "Sync accounts")}<span className="mt-1 block text-xs text-gray-500">{text("包含登录凭据、名称、隐藏状态、订阅到期时间、额度和重置次数缓存；各电脑独立选择当前账号。", "Includes credentials, names, hidden state, subscription expiry, quota and reset-credit caches. Active selection stays local.")}</span></span></label>
      <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={config.sync_settings} onChange={e => edit({ sync_settings: e.target.checked })} /><span>{text("同步系统设置", "Sync system settings")}<span className="mt-1 block text-xs text-gray-500">{text("语言、外观、刷新、切换方式、预热和更新检查；开机启动和 WebDAV 配置留在本机。", "Language, appearance, refresh, switch mode, warm-up and update checks. Startup and WebDAV configuration stay local.")}</span></span></label>
      <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={config.auto_sync} onChange={e => edit({ auto_sync: e.target.checked })} /><span>{text("自动双向同步", "Automatic two-way sync")}<span className="mt-1 block text-xs text-gray-500">{text("应用运行时每分钟检查；内容不变不上传。首次使用、删除、冲突或失败时暂停，等待你处理。", "Checks every minute while the app runs. Unchanged data is not uploaded. Pauses for first use, deletions, conflicts or errors.")}</span></span></label>
    </fieldset>
    <p className="text-xs text-amber-700 dark:text-amber-300">{text("同步账号的压缩文件包含完整登录凭据。请使用可信的 WebDAV 和 HTTPS。", "The compressed account file contains full login credentials. Use trusted WebDAV storage and HTTPS.")}</p>
    <div className="flex flex-wrap gap-2">
      <button disabled={disabled || pending || !config.server} className={button} onClick={() => void action(async () => { await invokeBackend("list_webdav_directories", { ...credentials(), directory: config.directory }); setMessage(text("连接成功，目录可读取。", "Connected. The directory can be read.")); })}>{text("测试连接", "Test connection")}</button>
      <button disabled={disabled || pending || !config.server} className={button} onClick={() => void action(async () => { await save(); setMessage(text("已保存。", "Saved.")); })}>{text("保存设置", "Save settings")}</button>
      <button disabled={disabled || pending || !config.server || (!config.sync_accounts && !config.sync_settings)} className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50" onClick={() => void start("merge")}>{sync.busy ? text("正在处理…", "Processing…") : text("双向同步", "Two-way sync")}</button>
      <button disabled={disabled || pending || !config.server || (!config.sync_accounts && !config.sync_settings)} aria-expanded={more} className={button} onClick={() => setMore(!more)}>{text("更多操作", "More actions")}</button>
    </div>
    {more && <div className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
      <p className="text-xs text-gray-500">{text("覆盖只处理已勾选的内容，执行前展示影响范围并保存恢复副本。", "Replacements affect only selected content. Review the changes before proceeding; a recovery copy is saved first.")}</p>
      {(["upload", "download"] as const).map(mode => <button key={mode} disabled={disabled || pending || (!config.sync_accounts && !config.sync_settings)} className={`${button} mr-2`} onClick={() => void start(mode)}>{modeTitle(mode)}</button>)}
    </div>}
    {dirty && <p className="text-xs text-gray-500">{text("有未保存的设置；开始同步前会先保存。", "Unsaved changes. Starting sync saves them first.")}</p>}
    {message && <p role="status" className="text-green-700 dark:text-green-300">{message}</p>}
    {(error || sync.error) && <p role="alert" className="break-words text-red-600 dark:text-red-300">{error || sync.error}</p>}
    {pending && plan && <section aria-label={text("同步预览", "Sync preview")} className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20">
      <h3 className="font-semibold">{text("同步预览", "Sync preview")} · {modeTitle(plan.mode)}</h3>
      <p>{config.sync_accounts ? text(`本机 ${plan.local_accounts} 个账号，云端 ${plan.cloud_accounts} 个账号。`, `${plan.local_accounts} local accounts, ${plan.cloud_accounts} cloud accounts.`) : text("本次仅同步系统设置。", "Only system settings are selected.")}</p>
      {plan.cloud_missing && <p>{text("云端暂无同步文件，将首次上传所选内容。", "No cloud sync file exists. Selected content will be uploaded for the first time.")}</p>}
      {plan.mode !== "upload" && <div><p className="font-medium">{text("从云端更新本机", "Update this computer from cloud")}: {summary(plan.to_local)}</p>{details(plan.to_local)}</div>}
      {plan.mode !== "download" && <div><p className="font-medium">{text("从本机更新云端", "Update cloud from this computer")}: {summary(plan.to_cloud)}</p>{details(plan.to_cloud)}</div>}
      {plan.mode !== "merge" && <p className="text-red-700 dark:text-red-300">{text("这是单向覆盖，目标端独有的所选内容也会被替换或删除。", "This is a one-way replacement. Selected data unique to the destination may be replaced or deleted.")}</p>}
      {plan.conflicts.length > 0 && <div role="alert" className="space-y-2">
        <p>{result.conflicts.length ? text("同步已暂停。请选择冲突内容采用哪一边，再检查更新后的预览。", "Sync paused. Choose a side for conflicts, then review the updated preview.") : text(`冲突内容将采用${plan.choice === "local" ? "本机" : "云端"}，其他变化仍合并。`, `Conflicts will use ${plan.choice === "local" ? "local" : "cloud"} values; other changes are still merged.`)}</p>
        <ul className="max-h-32 list-inside list-disc overflow-y-auto text-xs">{plan.conflicts.map((conflict, i) => <li key={i}>{conflict.account ? `${conflict.account}：` : text("系统设置：", "Settings: ")}{fieldName(conflict.field)}</li>)}</ul>
        <button className={button} disabled={disabled} onClick={() => void runDavSync({ choice: "local", mode: plan.mode })}>{text("冲突采用本机", "Keep local conflicts")}</button>{" "}
        <button className={button} disabled={disabled} onClick={() => void runDavSync({ choice: "remote", mode: plan.mode })}>{text("冲突采用云端", "Keep cloud conflicts")}</button>
      </div>}
      <p className="text-xs text-gray-500">{text("确认后执行；执行前保留本次操作涉及的本机和云端恢复副本。数据变化后会要求重新确认。", "Changes run after confirmation. A local recovery copy is saved first. If data changes, you must review again.")}</p>
      <div className="flex flex-wrap gap-2"><button disabled={disabled || result.conflicts.length > 0} className="rounded-lg bg-blue-600 px-3 py-2 text-white disabled:opacity-50" onClick={() => void runDavSync({ mode: plan.mode, choice: plan.choice ?? undefined, confirmation: plan.token })}>{text("确认", "Confirm ")}{modeTitle(plan.mode)}</button><button disabled={disabled} className={button} onClick={cancelDavPreview}>{text("取消", "Cancel")}</button></div>
    </section>}
    {sync.paused && !pending && !sync.error && <p className="text-xs text-amber-700 dark:text-amber-300">{text("自动双向同步已暂停；点击“双向同步”重新检查。", "Automatic two-way sync is paused. Click Two-way sync to check again.")}</p>}
    {result?.synced_at && plan && <div role="status" className="space-y-1 rounded-lg bg-green-50 p-3 text-xs text-green-800 dark:bg-green-900/20 dark:text-green-200">
      <p className="font-medium">{modeTitle(plan.mode)}{text("完成", " completed")} · {new Date(result.synced_at).toLocaleString(locale)} · {(result.bytes / 1024).toFixed(1)} KB</p>
      {plan.mode !== "upload" && <p>{text("从云端更新本机", "Updated this computer from cloud")}: {summary(plan.to_local)}</p>}
      {plan.mode !== "download" && <p>{text("从本机更新云端", "Updated cloud from this computer")}: {summary(plan.to_cloud)}{!result.uploaded && text("（内容未变，未上传）", " (unchanged; not uploaded)")}</p>}
      {result.recovery_path && <details><summary className="cursor-pointer">{text("已保存操作前的恢复副本", "Pre-operation recovery copy saved")}</summary><p className="mt-1 break-all">{result.recovery_path}</p></details>}
    </div>}
    {!ready && !error && <p>{text("正在读取设置…", "Loading settings…")}</p>}
  </div>;
}
