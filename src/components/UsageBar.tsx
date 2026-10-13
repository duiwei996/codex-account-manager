import { localizeError } from "../lib/errors";
import { getLocale, tr, useLocale } from "../lib/i18n";
import type { UsageInfo } from "../types";

interface UsageBarProps {
  usage?: UsageInfo;
  loading?: boolean;
}

function formatExactResetTime(resetAt: number | null | undefined): string {
  if (!resetAt) return "";

  const date = new Date(resetAt * 1000);
  if (getLocale() === "zh-CN") return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  const month = new Intl.DateTimeFormat("en-US", { month: "long" }).format(date);
  const day = date.getDate();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const period = date.getHours() >= 12 ? "PM" : "AM";
  const hour12 = date.getHours() % 12 || 12;

  return `${month} ${day}, ${hour12}:${minutes} ${period}`;
}

function formatWindowDuration(minutes: number | null | undefined): string {
  if (!minutes) return "";
  if (minutes < 60) return getLocale() === "zh-CN" ? `${minutes} 分钟` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return getLocale() === "zh-CN" ? `${hours} 小时` : `${hours}h`;
  return getLocale() === "zh-CN" ? `${Math.floor(hours / 24)} 天` : `${Math.floor(hours / 24)}d`;
}

function RateLimitBar({
  label,
  usedPercent,
  windowMinutes,
  resetsAt,
}: {
  label: string;
  usedPercent: number;
  windowMinutes?: number | null;
  resetsAt?: number | null;
}) {
  // Calculate remaining percentage
  const remainingPercent = Math.max(0, 100 - usedPercent);
  const cn = getLocale() === "zh-CN";

  // Color based on remaining (green = plenty left, red = almost none left)
  const colorClass =
    remainingPercent <= 10
      ? "bg-red-500"
      : remainingPercent <= 30
        ? "bg-amber-500"
        : "bg-emerald-500";

  const windowLabel = formatWindowDuration(windowMinutes);
  const exactResetLabel = formatExactResetTime(resetsAt);

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap justify-between gap-1 text-xs text-gray-500 dark:text-gray-400">
        <span>{windowLabel ? (cn ? `${windowLabel} 限额` : `${windowLabel} limit`) : label}</span>
        <span>
          {remainingPercent.toFixed(0)}% {cn ? "剩余" : "left"}
          {exactResetLabel && ` · ${cn ? "重置时间" : "Reset"}: ${exactResetLabel}`}
        </span>
      </div>
      <div className="h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${colorClass}`}
          style={{ width: `${Math.min(remainingPercent, 100)}%` }}
        ></div>
      </div>
    </div>
  );
}

export function UsageBar({ usage, loading }: UsageBarProps) {
  const locale = useLocale();
  const t = (text: string) => tr(text, locale);
  if (loading && !usage) {
    return (
      <div className="space-y-2">
        <div className="text-xs text-gray-400 dark:text-gray-500 italic animate-pulse">
          {t("Fetching usage...")}
        </div>
        <div className="h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden animate-pulse">
          <div className="h-full w-2/3 bg-gray-200 dark:bg-gray-700"></div>
        </div>
      </div>
    );
  }

  if (!usage) {
    return (
      <div className="text-xs text-gray-400 dark:text-gray-500 italic py-1 animate-pulse">
        {t("Fetching usage...")}
      </div>
    );
  }

  if (usage.error && usage.primary_used_percent == null && usage.secondary_used_percent == null) {
    return (
      <div className="text-xs text-gray-400 dark:text-gray-500 italic py-1">
        {localizeError(usage.error, locale)}
      </div>
    );
  }

  const hasPrimary = usage.primary_used_percent !== null && usage.primary_used_percent !== undefined;
  const hasSecondary = usage.secondary_used_percent !== null && usage.secondary_used_percent !== undefined;

  if (!hasPrimary && !hasSecondary) {
    return (
      <div className="text-xs text-gray-400 dark:text-gray-500 italic py-1">
        {t("No rate limit data")}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {(usage.error || usage.from_cache) && <p role="status" className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300">{usage.error && `${localizeError(usage.error, locale)} · `}{t("Cached usage")}{usage.recorded_at && ` · ${t("Recorded at")}: ${new Date(usage.recorded_at).toLocaleString(locale)}`}</p>}
      {hasPrimary && (
        <RateLimitBar
          label={t("5h Limit")}
          usedPercent={usage.primary_used_percent!}
          windowMinutes={usage.primary_window_minutes}
          resetsAt={usage.primary_resets_at}
        />
      )}
      {hasSecondary && (
        <RateLimitBar
          label={t("Weekly Limit")}
          usedPercent={usage.secondary_used_percent!}
          windowMinutes={usage.secondary_window_minutes}
          resetsAt={usage.secondary_resets_at}
        />
      )}
    </div>
  );
}
