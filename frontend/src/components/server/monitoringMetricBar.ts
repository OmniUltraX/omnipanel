export function metricBarColor(
  val: number,
  kind: "cpu" | "gpu" | "mem" | "disk",
  accent?: string,
): string {
  if (kind === "cpu" || kind === "gpu") {
    if (val >= 80) return "var(--danger)";
    if (val >= 50) return "var(--warn)";
    return accent ?? "var(--accent)";
  }
  if (val >= 85) return "var(--danger)";
  if (val >= 60) return "var(--warn)";
  return accent ?? "var(--success)";
}
