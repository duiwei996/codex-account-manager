import { tr, useLocale } from "../lib/i18n";

export function UpdateError({ phase, message }: { phase: "check" | "install" | "restart"; message: string }) {
  const locale = useLocale();
  const t = (key: string) => tr(key, locale);
  return (
    <p className="break-words text-sm text-red-600 dark:text-red-300" role="alert">
      {phase === "check" ? t("Update check failed:") : phase === "restart" ? t("Restart failed:") : t("Update failed:")}
      {" "}{message}
    </p>
  );
}
