import zh from "./locales/zh-CN.ts";
import en from "./locales/en-US.ts";
import { useSyncExternalStore } from "react";

export type AppLocale = "zh-CN" | "en-US";
const STORAGE_KEY = "codex-switcher-language";
const CHANGE_EVENT = "codex-switcher-language-changed";

export type TranslationKey = string;

export function getLocale(): AppLocale {
  if (typeof window === "undefined") return "zh-CN";
  return window.localStorage.getItem(STORAGE_KEY) === "en-US" ? "en-US" : "zh-CN";
}

export function setLocale(locale: AppLocale): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, locale);
  document.documentElement.lang = locale;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

export function useLocale(): AppLocale {
  return useSyncExternalStore(subscribe, getLocale, () => "zh-CN");
}

export function tr(key: TranslationKey, locale: AppLocale): string {
  return locale === "zh-CN" ? zh[key] ?? key : en[key] ?? key;
}
