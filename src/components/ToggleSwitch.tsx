export function ToggleSwitch({ id, checked, disabled, onChange, label }: {
  id: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void; label: string;
}) {
  return <button id={id} type="button" role="switch" aria-checked={checked} aria-label={label}
    disabled={disabled} onClick={() => onChange(!checked)}
    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "bg-blue-600" : "bg-gray-300 dark:bg-gray-600"}`}>
    <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? "left-0.5 translate-x-5" : "left-0.5"}`} />
  </button>;
}
