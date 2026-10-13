import { useEffect, useRef, useState } from "react";
import { tr, useLocale } from "../lib/i18n";
import { normalizeTimedWarmupTimes } from "../lib/autoWarmup";

interface Props {
  times: string[];
  onChange: (times: string[]) => void;
  onClose: () => void;
}

export function TimedWarmupEditor({ times, onChange, onClose }: Props) {
  const locale = useLocale();
  const t = (key: Parameters<typeof tr>[0]) => tr(key, locale);
  const sequence = useRef(times.length);
  const [rows, setRows] = useState(() => times.map((time, id) => ({ id, time })));
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    return () => previous?.focus();
  }, []);
  const persist = (next: typeof rows) => {
    setRows(next);
    const normalized = normalizeTimedWarmupTimes(next.map(row => row.time));
    if (next.some(row => !/^\d{2}:\d{2}$/.test(row.time)) || normalized.length !== next.length) {
      setError(t("Choose valid, different times. Changes have not been saved."));
      return;
    }
    setError(null);
    onChange(normalized);
  };
  const add = () => {
    if (!normalizeTimedWarmupTimes([draft]).length || rows.some(row => row.time === draft)) {
      setError(t("Choose valid, different times. Changes have not been saved."));
      return;
    }
    persist([...rows, { id: sequence.current++, time: draft }]);
    setDraft("");
  };
  const inputClass = "rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100";
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    if (event.key === "Tab") {
      const elements = panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)");
      if (!elements?.length) return;
      const first = elements[0], last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="timed-editor-title" className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-900">
      <div className="flex items-center justify-between gap-4">
        <h3 id="timed-editor-title" className="font-semibold text-gray-900 dark:text-gray-100">{t("Edit scheduled times")}</h3>
        <button onClick={onClose} aria-label={t("Close")} className="rounded-lg px-2 py-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800">✕</button>
      </div>
      <p className="my-3 text-xs leading-relaxed text-gray-500 dark:text-gray-400">{t("Runs daily at local time while the app is running. Missed times are skipped.")}</p>
      <div className="space-y-2">
        {rows.map(row => <div key={row.id} className="flex items-center justify-between gap-3">
          <input type="time" value={row.time} aria-label={`${t("Timed warm-up")} ${row.id + 1}`} className={inputClass} onChange={event => persist(rows.map(item => item.id === row.id ? { ...item, time: event.target.value } : item))} />
          <button onClick={() => persist(rows.filter(item => item.id !== row.id))} aria-label={`${t("Delete")} ${row.time}`} className="rounded-lg px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-900/20">{t("Delete")}</button>
        </div>)}
        {!rows.length && <p className="py-2 text-sm text-gray-400">{t("No times added yet.")}</p>}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-gray-100 pt-4 dark:border-gray-800">
        <input type="time" value={draft} aria-label={t("New scheduled time")} className={inputClass} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") add(); }} />
        <button onClick={add} disabled={!draft} className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50">{t("Add")}</button>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-300">{error}</p>}
    </div>
  </div>;
}
