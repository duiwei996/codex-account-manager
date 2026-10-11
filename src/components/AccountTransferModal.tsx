import { localizeError } from "../lib/errors";
import { useEffect, useState } from "react";
import { useLocale } from "../lib/i18n";
import { invokeBackend } from "../lib/platform";
import { maskAccountJson, type ExportDocument, type ExportFormat } from "../lib/accountTransfer";
import type { ImportAccountsSummary } from "../types";
interface Props { open: boolean; mode: "export" | "import"; accountId: string | null; onClose: () => void; onImported: () => Promise<void> }
export function AccountTransferModal({open: visible,mode,accountId,onClose,onImported}: Props) {
  const locale = useLocale();
  const label = (zh: string,en: string) => locale === "zh-CN" ? zh : en;
  const [format,setFormat] = useState<ExportFormat>("official");
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
    invokeBackend<ExportDocument[]>("export_accounts_json",{format,accountId})
      .then(value => {if(active)setDocuments(value);})
      .catch(error => {if(active)setError(String(error));})
      .finally(() => {if(active)setBusy(false);});
    return () => {active=false;};
  },[visible,mode,accountId,format]);
  if(!visible)return null;
  async function download(document?: ExportDocument) {
    setError("");setNotice("");
    try {
      const {save,open} = await import("@tauri-apps/plugin-dialog");
      const id = document?.account_id ?? accountId;
      const selected = id
        ? await save({title:label("导出 JSON","Export JSON"),defaultPath:format === "official" ? "auth.json" : document?.name ?? documents[0]?.name,filters:[{name:"JSON",extensions:["json"]}]})
        : await open({title:label("选择导出文件夹","Choose export folder"),directory:true,multiple:false});
      if(!selected || Array.isArray(selected))return;
      setBusy(true);
      const count = await invokeBackend<number>("save_accounts_json",{format,accountId:id,path:selected});
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
      await onImported();setPayload("");
      setNotice(label(`导入完成：已处理 ${summary.imported_count} 个账号`, `Import completed: processed ${summary.imported_count} accounts`));
    }catch(error){setError(String(error));}finally{setBusy(false);}
  }
  const button="rounded-xl border border-gray-200 px-4 py-2 text-sm font-medium dark:border-gray-700 disabled:opacity-50";
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={label("账号导入导出","Account transfer")}>
    <div className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl bg-white shadow-xl dark:bg-gray-900 dark:text-gray-100">
      <div className="flex items-center justify-between border-b border-gray-200 p-5 dark:border-gray-700">
        <h2 className="text-xl font-semibold">{mode === "export"?label("导出 JSON","Export JSON"):label("导入 JSON","Import JSON")}</h2>
        <button className={button} onClick={onClose} disabled={busy} aria-label={label("关闭","Close")}>✕</button>
      </div>
      <div className="space-y-4 overflow-y-auto p-5">
        {mode === "export" ? <>
          <label className="flex items-center gap-4 text-sm font-medium">{label("导出格式","Export format")}
            <select className={button} value={format} disabled={busy} onChange={event=>setFormat(event.target.value as ExportFormat)}>
              <option value="official">{label("官方 auth.json","Official auth.json")}</option><option value="cpa">{label("CPA 格式","CPA format")}</option>
            </select>
          </label>
          <div className="flex flex-wrap gap-3">
            <button className={button} disabled={busy||!documents.length} onClick={()=>setReveal(!reveal)}>{reveal?label("隐藏凭据","Hide credentials"):label("预览完整内容","Preview full content")}</button>
            {accountId&&<button className={button} disabled={busy||!documents.length} onClick={()=>void copy()}>{label("复制","Copy")}</button>}
            <button className={`${button} bg-blue-600 text-white`} disabled={busy||!documents.length} onClick={()=>void download()}>{accountId?label("下载","Download"):label("一键下载全部","Download all")}</button>
          </div>
          <p className="text-xs text-gray-500">{label("导出文件和复制内容包含完整登录凭据，请妥善保管。","Exported files and copied JSON contain full credentials. Keep them private.")}</p>
          {documents.map((document,index)=><section key={document.account_id} className="space-y-3 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
            {!accountId&&<div className="flex items-center justify-between"><h3 className="font-medium">{label(`账号 ${index+1}`,`Account ${index+1}`)}</h3><button className={button} disabled={busy} onClick={()=>void download(document)}>{label("下载","Download")}</button></div>}
            <textarea className="h-64 w-full rounded-xl border border-gray-200 bg-gray-50 p-4 font-mono text-sm dark:border-gray-700 dark:bg-gray-800" readOnly aria-label={label(`账号 ${index+1} JSON 预览`,`Account ${index+1} JSON preview`)} value={reveal?document.content:maskAccountJson(document.content)} />
          </section>)}
        </>:<>
          <p className="text-sm text-gray-500">{label("支持官方 auth.json 和 CPA 格式，可同时选择多个文件，也可粘贴一个账号或 JSON 数组。自动识别格式，重复账号会跳过。","Select multiple official auth.json or CPA files, or paste account JSON or an array. Formats are detected automatically; duplicates are skipped.")}</p>
          <button className={`${button} bg-blue-600 text-white`} disabled={busy} onClick={()=>void importJson(true)}>{label("选择文件批量导入","Import JSON files")}</button>
          <textarea className="h-64 w-full rounded-xl border border-gray-200 bg-gray-50 p-4 font-mono text-sm dark:border-gray-700 dark:bg-gray-800" value={payload} disabled={busy} onChange={event=>setPayload(event.target.value)} aria-label={label("粘贴账号 JSON","Paste account JSON")} spellCheck={false}/>
          <button className={button} disabled={busy||!payload.trim()} onClick={()=>void importJson(false)}>{label("导入粘贴内容","Import pasted JSON")}</button>
        </>}
        {busy&&<p role="status">{label("正在处理…","Processing…")}</p>}
        {notice&&<p className="text-sm text-green-700 dark:text-green-300" role="status">{notice}</p>}
        {error&&<p className="text-sm text-red-600 dark:text-red-300" role="alert">{localizeError(error)}</p>}
      </div>
    </div>
  </div>;
}
