import { getLocale, tr, type AppLocale } from "./i18n.ts";

const transferErrors: Record<string, string> = {
  "CPA Codex 格式仅支持登录账号，请使用官方格式导出 API Key 账号": "CPA supports login accounts only. Export API key accounts in official format.",
  "不支持的导出格式": "Unsupported export format",
  "没有可导出的账号": "There are no accounts to export",
  "请选择导出文件夹": "Please select an export folder",
  "文件夹中已有同名导出文件，请选择其他文件夹": "Export files already exist. Please select another folder.",
  "CPA 文件缺少 id_token": "The CPA file is missing id_token",
  "CPA 文件缺少 access_token": "The CPA file is missing access_token",
  "CPA 文件缺少 refresh_token": "The CPA file is missing refresh_token",
  "文件中没有可导入的账号凭据": "The file does not contain account credentials",
  "导入文件超过 8 MiB 限制": "The import exceeds the 8 MiB size limit",
  "批量导入总大小超过 8 MiB 限制": "The batch exceeds the 8 MiB size limit",
  "不是有效的 JSON 文件": "The file is not valid JSON",
  "选中的文件包含无效 JSON": "A selected file contains invalid JSON",
  "JSON 文件必须使用 UTF-8 编码": "JSON files must use UTF-8 encoding",
  "一次可导入 1–200 个账号": "Import 1–200 accounts at a time",
  "一次请选择 1–200 个 JSON 文件": "Select 1–200 JSON files at a time",
};

export function localizeError(error: unknown, locale: AppLocale = getLocale()): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (transferErrors[message]) return locale === "zh-CN" ? message : transferErrors[message];
  const translated = tr(message, locale);
  if (translated !== message) return translated;
  const choose = (zh: string, en: string) => locale === "zh-CN" ? zh : en;
  if (/Account name must contain/i.test(message)) return choose("账号名称最多 120 个字符，不能包含控制字符；登录时可以留空", "Account names can contain up to 120 characters and no control characters; leave blank when signing in to use the email.");
  if (/401|unauthorized|refresh_token_reused|invalid_grant/i.test(message)) return choose("登录验证失败，请重新登录或导入最新凭据后重试", "Authentication failed. Sign in again or import current credentials.");
  if (/403|forbidden/i.test(message)) return choose("请求被拒绝，请检查网络或账号权限后重试", "Request denied. Check your network or account permissions.");
  if (/429|too many requests/i.test(message)) return choose("请求过于频繁，请稍后重试", "Too many requests. Please retry later.");
  if (/busy|lock|正在被其他操作/.test(message)) return choose("账号数据正在处理中，请稍后重试", "Account data is busy. Please retry shortly.");
  if (/timeout|timed out/i.test(message)) return choose("请求超时，请检查网络后重试", "Request timed out. Check your network and retry.");
  if (/network|connect|dns|request|error sending/i.test(message)) return choose("网络请求失败，请检查网络或代理设置", "Network request failed. Check your network or proxy settings.");
  if (/missing.*token|invalid.*token|fresh id_token/i.test(message)) return choose("账号凭据不完整或已过期，请导入最新凭据或重新登录", "Credentials are incomplete or expired. Import current credentials or sign in again.");
  if (/invalid|missing|required|validate/i.test(message)) return choose("文件或参数校验失败，请检查内容后重试", "File or parameter validation failed. Check the contents and retry.");
  if (locale === "zh-CN" && /^[\x00-\x7F]*$/.test(message)) return "操作失败，请检查输入或稍后重试";
  if (locale === "en-US" && /[\u4e00-\u9fff]/.test(message)) return "Operation failed. Check your input or retry later.";
  return message;
}
