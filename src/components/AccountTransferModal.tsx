import { CenteredSelect } from "./CenteredSelect";
import { groupAccountsByPlan } from "../lib/accountGroups";
import { localizeError } from "../lib/errors";
import { useEffect, useState } from "react";
import { useLocale } from "../lib/i18n";
import { invokeBackend } from "../lib/platform";
import { maskAccountJson, type ExportDocument, type ExportFormat } from "../lib/accountTransfer";
import type { AccountInfo, ImportAccountsSummary } from "../types";
interface Props { open: boolean; mode: "export" | "import"; accountId: string | null; accounts?: AccountInfo[]; onClose: () => void; onImported: (summary: ImportAccountsSummary) => Promise<void> }
export function AccountTransferModal(props: Props) {
  return <AccountTransferForm key={`${props.open}:${props.mode}:${props.accountId ?? "all"}`} {...props} />;
}

function AccountTransferForm({open: visible,mode: initialMode,accountId,accounts = [],onClose,onImported}: Props) {
  const [mode, setMode] = useState(initialMode);
  const locale = useLocale();
  const label = (zh: string,en: string) => locale === "zh-CN" ? zh : en;
  const [format,setFormat] = useState<ExportFormat>(accountId ? "official" : "all");
  const [category, setCategory] = useState("all");
  const [accountStatus, setAccountStatus] = useState("valid");
  const filters = { category: accountId ? "all" : category, accountStatus: accountId ? "all" : accountStatus };
  const categories = groupAccountsByPlan(accounts, true);
  const categoryLabel = (key: string) => key === "api_key" ? label("API Key 账号", "API key accounts") :
    key === "unknown" ? label("未知套餐", "Unknown plan") : key === "free" ? label("免费账号", "Free accounts") : key;
  const [documents,setDocuments] = useState<ExportDocument[]>([]);
  const [reveal,setReveal] = useState(false);
  const [payload,setPayload] = useState("");
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [notice,setNotice] = useState("");
  useEffect(() => {
    let active = true;
    setDocuments([]);setPayload("");setReveal(false);setError("");setNotice("");
    if (!visible || mode !== "export") {setBusy(false);return;}
    setBusy(true);
    invokeBackend<ExportDocument[]>("export_accounts_json",{format,accountId: format === "all" ? null : accountId, ...filters})
      .then(value => {if(active)setDocuments(value);})
      .catch(error => {if(active)setError(String(error));})
      .finally(() => {if(active)setBusy(false);});
    return () => {active=false;};
  },[visible,mode,accountId,format,category,accountStatus]);
  if(!visible)return null;
  async function download(document?: ExportDocument) {
    setError("");setNotice("");
    try {
      const {save,open} = await import("@tauri-apps/plugin-dialog");
      const id = format === "all" ? null : document?.account_id ?? accountId;
      const selected = id || format === "all"
        ? await save({title:label("导出 JSON","Export JSON"),defaultPath:document?.name ?? documents[0]?.name,filters:[{name:"JSON",extensions:["json"]}]})
        : await open({title:label("选择导出文件夹","Choose export folder"),directory:true,multiple:false});
      if(!selected || Array.isArray(selected))return;
      setBusy(true);
      const count = await invokeBackend<number>("save_accounts_json",{format,accountId:id,path:selected, ...filters});
      setNotice(label(`已导出 ${count} 个账号`, `Exported ${count} accounts`));
    }catch(error){setError(String(error));}finally{setBusy(false);}
  }
  async function copy() {
    try{await navigator.clipboard.writeText(documents[0].content);setNotice(label("已复制完整 JSON","Full JSON copied"));}
    catch(error){setError(String(error));}
  }
  async function importJson(files: boolean) {
    setError("");setNotice("");
    try {
      let paths: string[] = [];
      if(files){
        const {open} = await import("@tauri-apps/plugin-dialog");
        const selected = await open({multiple:true,title:label("选择账号 JSON 文件（可多选）","Select account JSON files"),filters:[{name:"JSON",extensions:["json"]}]});
        if(!selected)return;
        paths=Array.isArray(selected)?selected:[selected];
      }
      setBusy(true);
      const summary = files
        ? await invokeBackend<ImportAccountsSummary>("import_accounts_json_files",{paths})
        : await invokeBackend<ImportAccountsSummary>("import_accounts_json",{payload});
      await onImported(summary);setPayload("");
      setNotice(label(`导入完成：已处理 ${summary.imported_count} 个账号`, `Import completed: processed ${summary.imported_count} accounts`));
    }catch(error){setError(String(error));}finally{setBusy(false);}
  }
  const button="rounded-xl border border-gray-200 px-4 py-2 text-sm font-medium dark:border-gray-700 disabled:opacity-50";
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={label("账号导入导出","Account transfer")}>
    <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl bg-white shadow-xl dark:bg-gray-900 dark:text-gray-100">
      <div className="flex items-center justify-between border-b border-gray-200 p-5 dark:border-gray-700">
        <h2 className="text-xl font-semibold">{accountId ? label("导出 JSON","Export JSON") : label("导入 / 导出","Import / Export")}</h2>
        <button className={button} onClick={onClose} disabled={busy} aria-label={label("关闭","Close")}>✕</button>
      </div>
      <div className="space-y-4 overflow-y-auto p-5">
        {!accountId && <div role="tablist" aria-label={label("导入 / 导出", "Import / Export")} className="flex gap-1 rounded-xl bg-gray-100 p-1 dark:bg-gray-800">
          {(["import", "export"] as const).map(tab => <button key={tab} id={`transfer-${tab}-tab`} role="tab" aria-selected={mode === tab} aria-controls="transfer-panel" tabIndex={mode === tab ? 0 : -1} disabled={busy} onClick={() => setMode(tab)}
            onKeyDown={event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? "import" : event.key === "End" ? "export" : tab === "import" ? "export" : "import"; setMode(next); document.getElementById(`transfer-${next}-tab`)?.focus(); } }}
            className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 ${mode === tab ? "bg-white text-blue-600 shadow-sm dark:bg-gray-700 dark:text-blue-300" : "text-gray-500 dark:text-gray-400"}`}>
            {tab === "import" ? label("导入", "Import") : label("导出", "Export")}
          </button>)}
        </div>}
        <div id="transfer-panel" role={accountId ? undefined : "tabpanel"} aria-labelledby={accountId ? undefined : `transfer-${mode}-tab`} className="space-y-4">
        {mode === "export" ? <>
          {!accountId && <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-3 text-sm font-medium" htmlFor="export-category">{label("分类", "Category")}
              <CenteredSelect id="export-category" className={button} value={category} disabled={busy} onChange={event => setCategory(event.target.value)}>
                <option value="all">{label("全部账号", "All accounts")}</option>
                {categories.map(group => <option key={group.key} value={group.key}>{categoryLabel(group.key)}</option>)}
              </CenteredSelect>
            </label>
            <label className="flex items-center gap-3 text-sm font-medium" htmlFor="export-status">{label("账号状态", "Account status")}
              <CenteredSelect id="export-status" className={button} value={accountStatus} disabled={busy} onChange={event => setAccountStatus(event.target.value)}>
                <option value="all">{label("全部状态", "All statuses")}</option>
                <option value="valid">{label("有效账号", "Valid accounts")}</option>
                <option value="invalid">{label("失效账号", "Invalid accounts")}</option>
              </CenteredSelect>
            </label>
          </div>}
          <label className="flex items-center gap-4 text-sm font-medium">{label("导出格式","Export format")}
            <CenteredSelect className={button} value={format} disabled={busy} onChange={event=>setFormat(event.target.value as ExportFormat)}>
              {!accountId && <option value="all">{label("合并 JSON","Combined JSON")}</option>}
              <option value="official">{label("官方 auth.json","Official auth.json")}</option><option value="cpa">{label("CPA 格式","CPA format")}</option>
            </CenteredSelect>
          </label>
          {format === "all" && <p className="text-sm text-gray-500">{label("将符合分类和状态筛选的账号合并为一个 JSON，每个账号采用 auth.json 格式，可批量导入。","Export matching accounts as one JSON array of auth.json objects, ready for batch import.")}</p>}
          <div className="flex flex-wrap gap-3">
            <button className={button} disabled={busy||!documents.length} onClick={()=>setReveal(!reveal)}>{reveal?label("隐藏凭据","Hide credentials"):label("预览完整内容","Preview full content")}</button>
            {(accountId || format === "all")&&<button className={button} disabled={busy||!documents.length} onClick={()=>void copy()}>{label("复制","Copy")}</button>}
            <button className={`${button} bg-blue-600 text-white`} disabled={busy||!documents.length} onClick={()=>void download()}>{accountId || format === "all"?label("下载","Download"):label("下载筛选结果","Download matching accounts")}</button>
          </div>
          <p className="text-xs text-gray-500">{label("导出文件和复制内容包含完整登录凭据，请妥善保管。","Exported files and copied JSON contain full credentials. Keep them private.")}</p>
          {documents.map((document,index)=><section key={document.account_id} className="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
            {!accountId && format !== "all"&&<div className="flex items-center justify-between"><h3 className="font-medium">{label(`账号 ${index+1}`,`Account ${index+1}`)}</h3><button className={button} disabled={busy} onClick={()=>void download(document)}>{label("下载","Download")}</button></div>}
            <textarea className="h-64 w-full rounded-xl border border-gray-200 bg-gray-50 p-4 font-mono text-sm dark:border-gray-700 dark:bg-gray-800" readOnly aria-label={label(`账号 ${index+1} JSON 预览`,`Account ${index+1} JSON preview`)} value={reveal?document.content:maskAccountJson(document.content)} />
          </section>)}
        </>:<>
          <p className="text-sm text-gray-500">{label("支持官方 auth.json、CPA 格式和全部账号 JSON，可同时选择多个文件，也可粘贴一个账号或 JSON 数组。相同邮箱和类型的账号会更新凭据。","Select multiple official auth.json, CPA or all-account JSON files, or paste account JSON or an array. Matching email and account type updates existing credentials.")}</p>
          <button className={`${button} bg-blue-600 text-white`} disabled={busy} onClick={()=>void importJson(true)}>{label("选择文件批量导入","Import JSON files")}</button>
          <textarea className="h-64 w-full rounded-xl border border-gray-200 bg-gray-50 p-4 font-mono text-sm dark:border-gray-700 dark:bg-gray-800" value={payload} disabled={busy} onChange={event=>setPayload(event.target.value)} aria-label={label("粘贴账号 JSON","Paste account JSON")} spellCheck={false}/>
          <button className={button} disabled={busy||!payload.trim()} onClick={()=>void importJson(false)}>{label("导入粘贴内容","Import pasted JSON")}</button>
        </>}
        </div>
        {busy&&<p role="status">{label("正在处理…","Processing…")}</p>}
        {notice&&<p className="text-sm text-green-700 dark:text-green-300" role="status">{notice}</p>}
        {error&&<p className="text-sm text-red-600 dark:text-red-300" role="alert">{localizeError(error)}</p>}
      </div>
    </div>
  </div>;
}
