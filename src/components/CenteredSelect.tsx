import { Children, isValidElement, type ReactNode, type SelectHTMLAttributes } from "react";

// Keep native keyboard/menu behavior, centering the value and arrow as a group.
export function CenteredSelect({ className = "", children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const options = Children.toArray(children).filter(isValidElement<{ value?: string | number; children?: ReactNode }>);
  const value = props.value ?? props.defaultValue ?? options[0]?.props.value;
  const selected = options.find(option => String(option.props.value) === String(value)) ?? options[0];
  return <span className={`relative inline-grid min-w-0 items-center justify-items-center focus-within:ring-2 focus-within:ring-blue-400 ${props.disabled ? "opacity-50" : ""} ${className}`}>
    <span aria-hidden="true" className="pointer-events-none inline-flex max-w-full items-center justify-center gap-2.5">
      <span className="truncate">{selected?.props.children}</span>
      <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
    </span>
    <select {...props} className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default">{children}</select>
  </span>;
}
