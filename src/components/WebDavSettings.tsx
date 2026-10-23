import { ActionIcon } from "./ActionIcon";
import { useEffect, useState } from "react";
import { invokeBackend } from "../lib/platform";
import { useLocale } from "../lib/i18n";
import { DAV_CONFIG_CHANGED_EVENT, DAV_STATE_EVENT, davState, defaultDavConfig, resumeDavSync, runDavSync, type ConfigView, type DavConfig, type DavDirectory, type SyncMode } from "../lib/webdav";

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
  useEffect(() => {
    let disposed = false;
    void invokeBackend<ConfigView>("get_webdav_config").then(view => {
      if (!disposed) { setConfig({ ...defaultDavConfig, ...view.config }); setPasswordSaved(view.password_saved); setReady(true); }
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
    setConfig({ ...defaultDavConfig, ...view.config }); setPasswordSaved(view.password_saved); setPassword(""); setDirty(false); resumeDavSync(); window.dispatchEvent(new Event(DAV_CONFIG_CHANGED_EVENT));
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
  const row = "grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-4 py-2";
  const result = sync.result;
  const plan = result?.preview;
  const modeTitle = (mode: SyncMode) => mode === "upload" ? text("本地覆盖云端", "Replace cloud with local") : mode === "download" ? text("云端覆盖本地", "Replace local with cloud") : text("立即同步", "Sync now");
  const start = (mode: SyncMode) => action(async () => { setBrowser(null); await save(); await runDavSync({ mode }); });
  return <div className="space-y-4 py-4 text-sm">
    <fieldset disabled={disabled || pending} className="divide-y divide-gray-100 dark:divide-gray-800">
      <label className={row}><span>{text("服务器地址", "Server URL")}</span><input aria-label={text("服务器地址", "Server URL")} className={input} type="url" placeholder="https://dav.example.com/dav/" value={config.server} autoComplete="off" onChange={e => edit({ server: e.target.value })} /></label>
      <label className={row}><span>{text("用户名", "Username")}</span><input className={input} value={config.username} autoComplete="off" onChange={e => edit({ username: e.target.value })} /></label>
      <label className={row}><span>{text("密码 / 应用密码", "Password / App password")}</span><input className={input} type="password" autoComplete="new-password" value={password} placeholder={passwordSaved ? text("已安全保存，留空保持不变", "Saved securely; leave blank to keep") : ""} onChange={e => { setPassword(e.target.value); setDirty(true); }} /></label>
      <label className={row}><span>{text("同步目录", "Sync directory")}</span><div className="flex gap-2"><input className={input} value={config.directory} onChange={e => edit({ directory: e.target.value })} /><button type="button" disabled={!config.server} className={`${button} shrink-0`} onClick={() => void browse("/")}>{text("选择目录", "Browse")}</button></div></label>
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
    <fieldset disabled={disabled || pending} className="divide-y divide-gray-100 dark:divide-gray-800">
      <label className="flex items-center justify-between gap-4 py-3"><span>{text("同步账号", "Sync accounts")}<span className="mt-1 block text-xs text-gray-500">{text("包含登录凭据、名称、风控及隐藏状态、订阅到期时间、额度和重置次数缓存；各电脑独立选择当前账号。", "Includes credentials, names, hidden state, subscription expiry, quota and reset-credit caches. Active selection stays local.")}</span></span><input type="checkbox" className="h-4 w-4 shrink-0 accent-blue-600" checked={config.sync_accounts} onChange={e => edit({ sync_accounts: e.target.checked })} /></label>
      <label className="flex items-center justify-between gap-4 py-3"><span>{text("同步系统设置", "Sync system settings")}<span className="mt-1 block text-xs text-gray-500">{text("语言、外观、刷新、切换方式、预热和更新检查；开机启动和 WebDAV 配置留在本机。", "Language, appearance, refresh, switch mode, warm-up and update checks. Startup and WebDAV configuration stay local.")}</span></span><input type="checkbox" className="h-4 w-4 shrink-0 accent-blue-600" checked={config.sync_settings} onChange={e => edit({ sync_settings: e.target.checked })} /></label>
      <label className="flex items-center justify-between gap-4 py-3"><span>{text("自动同步", "Automatic sync")}<span className="mt-1 block text-xs text-gray-500">{text("按设置的间隔检查，云端变化时弹窗选择。", "Checks at the selected interval; prompts when the cloud changes.")}</span></span><input type="checkbox" className="h-4 w-4 shrink-0 accent-blue-600" checked={config.auto_sync} onChange={e => edit({ auto_sync: e.target.checked })} /></label>
      <label className={row}><span className="whitespace-nowrap">{text("自动同步间隔", "Automatic sync interval")}</span><div className="flex items-center justify-end gap-2"><input aria-label={text("自动同步间隔（分钟）", "Automatic sync interval (minutes)")} className="w-24 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400/20 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100" type="number" min={1} max={1440} step={1} value={config.auto_sync_interval_minutes} onChange={e => edit({ auto_sync_interval_minutes: Number(e.target.value) })} /><span className="text-sm text-gray-500 dark:text-gray-400">{text("分钟", "minutes")}</span></div></label>
    </fieldset>
    <div className="flex justify-end gap-2 border-b border-gray-100 pb-4 dark:border-gray-800">
      <button disabled={disabled || pending || !config.server} className={button} onClick={() => void action(async () => { await invokeBackend("list_webdav_directories", { ...credentials(), directory: config.directory }); setMessage(text("连接成功，目录可读取。", "Connected. The directory can be read.")); })}>{text("测试连接", "Test connection")}</button>
      <button disabled={disabled || pending || !config.server} className={button} onClick={() => void action(async () => { await save(); setMessage(text("已保存。", "Saved.")); })}>{text("保存设置", "Save settings")}</button>
    </div>
    <section className="space-y-3" aria-label={text("同步操作", "Sync actions")}>
      <div className="flex items-center justify-between gap-4 py-2">
        <div><p className="font-medium">{text("同步数据", "Sync data")}</p><p className="mt-1 text-xs text-gray-500">{text("云端有变化时，由你选择使用哪份。", "Choose a copy when the cloud changes.")}</p></div>
        <button disabled={disabled || pending || !config.server || (!config.sync_accounts && !config.sync_settings)} className="flex shrink-0 items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50" onClick={() => void start("merge")}><ActionIcon name="sync" spinning={sync.busy} />{sync.busy ? text("正在处理…", "Processing…") : text("立即同步", "Sync now")}</button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {(["upload", "download"] as const).map(mode => <div key={mode} className="rounded-xl border border-gray-200 p-3 dark:border-gray-700">
          <button disabled={disabled || pending || !config.server || (!config.sync_accounts && !config.sync_settings)} className="flex items-center gap-2 text-sm font-medium text-gray-700 hover:text-blue-600 disabled:opacity-50 dark:text-gray-200" onClick={() => void start(mode)}><ActionIcon name={mode === "upload" ? "export" : "import"} />{modeTitle(mode)}</button>
          <p className="mt-1.5 text-xs text-gray-500">{mode === "upload" ? text("以本地为准，替换云端数据", "Replace cloud data with this computer") : text("以云端为准，替换本地数据", "Replace this computer with cloud data")}</p>
        </div>)}
      </div>
    </section>
    <p className="text-xs text-gray-400">{text("账号同步包含登录凭据，请使用可信的 HTTPS 服务。", "Account sync includes credentials. Use trusted HTTPS storage.")}</p>
    {dirty && <p className="text-xs text-gray-500">{text("有未保存的设置；开始同步前会先保存。", "Unsaved changes. Starting sync saves them first.")}</p>}
    {message && <p role="status" className="text-green-700 dark:text-green-300">{message}</p>}
    {(error || sync.error) && <p role="alert" className="break-words text-red-600 dark:text-red-300">{error || sync.error}</p>}
    {sync.paused && !pending && !sync.error && <p className="text-xs text-amber-700 dark:text-amber-300">{text("自动同步已暂停；点击“立即同步”重新检查。", "Automatic sync is paused. Click Sync now to check again.")}</p>}
    {result?.synced_at && plan && <div role="status" className="space-y-1 rounded-lg bg-green-50 p-3 text-xs text-green-800 dark:bg-green-900/20 dark:text-green-200">
      <p className="font-medium">{modeTitle(plan.mode)}{text("完成", " completed")} · {new Date(result.synced_at).toLocaleString(locale)} · {(result.bytes / 1024).toFixed(1)} KB</p>
      <p>{result.uploaded ? text("已上传本地数据。", "Local data uploaded.") : text("同步检查完成。", "Sync check completed.")}</p>

    </div>}
    {!ready && !error && <p>{text("正在读取设置…", "Loading settings…")}</p>}
  </div>;
}
