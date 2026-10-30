/** Normalize spelling while preserving distinct server plan types. */
export function normalizeAccountPlan(plan?: string | null): string {
  const key = plan?.trim().toLowerCase() || "unknown";
  return key;
}
