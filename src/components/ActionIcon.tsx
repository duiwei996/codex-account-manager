type Action = "refresh" | "settings" | "import" | "export" | "warmup" | "delete" | "add" | "rename" | "stats" | "auto";
const paths: Record<Action, string> = {
  rename: "M16 3l5 5 M4 20l4-1L21 6a2.8 2.8 0 0 0-4-4L4 15l-1 6Z",
  stats: "M4 3v18h17 M8 16v-4 M13 16V8 M18 16V5",
  auto: "M20 7v5h-5 M20 12a8 8 0 1 0-2.34 5.66 M12 7v5l3 2",
  add: "M12 5v14 M5 12h14",
  refresh: "M20 7v5h-5 M20 12a8 8 0 1 0-2.34 5.66",
  settings: "M18.47 9.32 L20.86 10.44 L20.86 13.56 L18.47 14.68 L18.47 14.68 L19.37 17.16 L17.16 19.37 L14.68 18.47 L14.68 18.47 L13.56 20.86 L10.44 20.86 L9.32 18.47 L9.32 18.47 L6.84 19.37 L4.63 17.16 L5.53 14.68 L5.53 14.68 L3.14 13.56 L3.14 10.44 L5.53 9.32 L5.53 9.32 L4.63 6.84 L6.84 4.63 L9.32 5.53 L9.32 5.53 L10.44 3.14 L13.56 3.14 L14.68 5.53 L14.68 5.53 L17.16 4.63 L19.37 6.84 L18.47 9.32 Z M15 12a3 3 0 1 0-6 0a3 3 0 1 0 6 0Z",
  import: "M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5",
  export: "M12 15V3 M7 8l5-5 5 5 M4 16v5h16v-5",
  warmup: "M13 2 4 14h7l-1 8 10-12h-7l1-8Z",
  delete: "M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7",
};
export function ActionIcon({name, spinning = false}: {name: Action; spinning?: boolean}) {
  return <svg className={`${name === "refresh" ? "h-5 w-5" : "h-4 w-4"} ${spinning ? "animate-spin" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}
