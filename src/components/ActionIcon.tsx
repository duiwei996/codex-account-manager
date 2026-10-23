import {
  FolderSync, ChartColumn, CloudUpload, FileInput, FileOutput, LoaderCircle,
  Pencil, Plus, RotateCw, Settings, ShieldMinus, ShieldPlus, Timer, Trash2, Zap,
  type LucideIcon,
} from "lucide-react";

type Action = "sync" | "risk-add" | "risk-remove" | "transfer" | "refresh" | "settings" | "import" | "export" | "warmup" | "delete" | "add" | "rename" | "stats" | "auto";
const icons: Record<Action, LucideIcon> = {
  sync: CloudUpload,
  "risk-add": ShieldPlus,
  "risk-remove": ShieldMinus,
  transfer: FolderSync,
  refresh: RotateCw,
  settings: Settings,
  import: FileInput,
  export: FileOutput,
  warmup: Zap,
  delete: Trash2,
  add: Plus,
  rename: Pencil,
  stats: ChartColumn,
  auto: Timer,
};

export function ActionIcon({ name, spinning = false }: { name: Action; spinning?: boolean }) {
  const Icon = name === "sync" && spinning ? LoaderCircle : icons[name];
  return <Icon size={["refresh", "sync", "transfer"].includes(name) ? 20 : 18}
    strokeWidth={1.8} className={spinning ? "animate-spin" : undefined} aria-hidden="true" />;
}
