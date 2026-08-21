/** prod / prod-* / production 视为生产环境。 */
export function isProdEnvTag(tag?: string | null): boolean {
  const normalized = (tag ?? "").trim().toLowerCase();
  if (!normalized) return false;
  return normalized === "prod" || normalized === "production" || normalized.startsWith("prod-");
}
