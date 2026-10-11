import { promptForSecret } from "./secretPrompt";

export type FileSource = string | File;

const WEB_TOKEN_STORAGE_KEY = "codex-switcher-web-token";
let pendingWebToken: Promise<string | null> | null = null;

async function getWebAccessToken(): Promise<string | null> {
  const stored = window.sessionStorage.getItem(WEB_TOKEN_STORAGE_KEY);
  if (stored) return stored;
  if (!pendingWebToken) {
    pendingWebToken = promptForSecret({
      title: "网页版访问令牌 / Web access token",
      detail: "Enter the CODEX_SWITCHER_WEB_TOKEN from the server. The token stays in this browser tab and is not sent elsewhere.",
      minLength: 32,
    }).then((value) => {
      if (value) window.sessionStorage.setItem(WEB_TOKEN_STORAGE_KEY, value);
      return value;
    }).finally(() => { pendingWebToken = null; });
  }
  return pendingWebToken;
}

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function invokeBackend<T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, args);
  }

  const token = await getWebAccessToken();
  if (!token) throw new Error("A web access token is required / 必须填写网页访问令牌");
  const response = await fetch(`/api/invoke/${encodeURIComponent(command)}`, {
    signal: AbortSignal.timeout(40000),
    cache: "no-store",
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(args ?? {}),
  });
  if (response.status === 401) {
    window.sessionStorage.removeItem(WEB_TOKEN_STORAGE_KEY);
    throw new Error("Web access token was rejected. Retry to enter a new token.");
  }

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    const message =
      typeof payload?.error === "string"
        ? payload.error
        : `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  return payload as T;
}

export async function openExternalUrl(url: string): Promise<void> {
  if (isTauriRuntime()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}

export async function pickAuthJsonFile(): Promise<FileSource | null> {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
      title: "Select auth.json file",
    });

    if (!selected || Array.isArray(selected)) return null;
    return selected;
  }

  return pickBrowserFile(".json,application/json");
}

export function describeFileSource(source: FileSource | null): string {
  if (!source) return "No file selected";
  return typeof source === "string" ? source : source.name;
}

async function pickBrowserFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    let settled = false;

    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", handleWindowFocus);
      input.remove();
      resolve(file);
    };

    const handleWindowFocus = () => {
      window.setTimeout(() => {
        finish(input.files?.[0] ?? null);
      }, 0);
    };

    input.addEventListener(
      "change",
      () => {
        finish(input.files?.[0] ?? null);
      },
      { once: true }
    );

    document.body.appendChild(input);
    window.addEventListener("focus", handleWindowFocus, { once: true });
    input.click();
  });
}

async function readJsonResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return { error: "Server returned an invalid response" };
  }
}
