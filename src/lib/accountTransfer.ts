export interface ExportDocument { account_id: string; name: string; content: string }
export type ExportFormat = "official" | "cpa";
export function maskAccountJson(content: string): string {
  const fields = new Set(["OPENAI_API_KEY", "id_token", "access_token", "refresh_token", "account_id", "email"]);
  return JSON.stringify(JSON.parse(content), (key, value) => fields.has(key) && typeof value === "string" && value
    ? value.length > 6 ? value.slice(0, 3) + "***" + value.slice(-3) : "***" : value, 2);
}
