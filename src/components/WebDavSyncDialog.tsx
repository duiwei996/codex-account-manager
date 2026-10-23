import { useEffect, useRef, useState } from "react";
import { useLocale } from "../lib/i18n";
import { DAV_STATE_EVENT, cancelDavPreview, davState, runDavSync } from "../lib/webdav";

export function WebDavSyncDialog() {
  const locale = useLocale();
  const text = (zh: string, en: string) => locale === "zh-CN" ? zh : en;
  const [sync, setSync] = useState({ ...davState });
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const update = () => setSync({ ...davState });
    window.addEventListener(DAV_STATE_EVENT, update);
    return () => window.removeEventListener(DAV_STATE_EVENT, update);
  }, []);
  const plan = sync.result?.needs_confirmation ? sync.result.preview : null;
  useEffect(() => {
    if (plan && !dialog.current?.open) dialog.current?.showModal();
  }, [plan?.token]);
  if (!plan) return null;
  const replacement = plan.mode !== "merge";
  const direction = plan.mode === "upload" ? text("本地覆盖云端", "Replace cloud with local") : text("云端覆盖本地", "Replace local with cloud");
  const button = "rounded-lg border border-gray-300 px-4 py-2 text-sm disabled:opacity-50 dark:border-gray-600";
  return <dialog ref={dialog} aria-labelledby="webdav-choice-title" onCancel={event => { event.preventDefault(); if (!sync.busy) cancelDavPreview(); }}
    className="fixed inset-0 z-[100] m-auto w-full max-w-md rounded-2xl bg-white p-6 text-gray-900 shadow-xl backdrop:bg-black/40 dark:bg-gray-900 dark:text-gray-100">
    <h2 id="webdav-choice-title" className="text-lg font-semibold">{replacement ? text(`确认${direction}？`, `Confirm: ${direction}?`) : text("选择同步数据", "Choose a sync copy")}</h2>
    <p className="mt-3 text-sm">{replacement ? text("目标端的账号、设置及缓存将按所选同步范围替换，目标端独有内容也会删除。", "Selected accounts, settings and caches replace the destination, including deletion of destination-only data.") : text("本机与云端数据不同，请选择以哪份为准。", "Local and cloud data differ. Choose which copy to use.")}</p>
    <p className="mt-2 text-xs text-gray-500">{text(`本机 ${plan.local_accounts} 个账号 · 云端 ${plan.cloud_accounts} 个账号`, `${plan.local_accounts} local accounts · ${plan.cloud_accounts} cloud accounts`)}</p>
    {!replacement && <p className="mt-2 text-xs text-gray-500">{text("所选账号和设置将覆盖另一端，包括新增、修改和删除。", "Selected accounts and settings replace the other copy, including additions, edits and deletions.")}</p>}
    {plan.cloud_missing && <p className="mt-2 text-xs text-gray-500">{text("云端暂无备份。", "No cloud backup exists.")}</p>}
    {sync.error && <p role="alert" className="mt-3 text-sm text-red-600">{sync.error}</p>}
    <div className="mt-5 flex flex-wrap gap-2">
      <button autoFocus disabled={sync.busy} className={button} onClick={cancelDavPreview}>{text("取消", "Cancel")}</button>
      {replacement ? <button disabled={sync.busy} className={button} onClick={() => void runDavSync({ mode: plan.mode, confirmation: plan.token })}>{text("确认覆盖", "Confirm replacement")}</button> : <>
      <button disabled={sync.busy} className={button} onClick={() => void runDavSync({ mode: plan.mode, choice: "local", confirmation: plan.token })}>{text("使用本地", "Use local")}</button>
      <button disabled={sync.busy || plan.cloud_missing} className={button} onClick={() => void runDavSync({ mode: plan.mode, choice: "remote", confirmation: plan.token })}>{text("使用云端", "Use cloud")}</button>
      </>}

    </div>
  </dialog>;
}
