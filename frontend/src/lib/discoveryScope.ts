import type { DiscoveryScope } from "../ipc/bindings";
import { isProdEnvTag } from "./envTag";

export type DiscoverySkipResult = { skipped: true; reason: "prod" | "cancelled" };

export { isProdEnvTag };

export function isDiscoverySkip(value: unknown): value is DiscoverySkipResult {
  if (!value || typeof value !== "object") return false;
  const rec = value as { skipped?: unknown; reason?: unknown };
  return rec.skipped === true && (rec.reason === "prod" || rec.reason === "cancelled");
}

export function sshDiscoveryScope(
  connections: Array<{ id: string; kind: string; envTag?: string | null }>,
): { scope: DiscoveryScope; skippedProdCount: number; prodHostIds: string[] } {
  const ssh = connections.filter((c) => c.kind === "ssh");
  const nonProd = ssh.filter((c) => !isProdEnvTag(c.envTag));
  const prod = ssh.filter((c) => isProdEnvTag(c.envTag));
  return {
    scope: { hostIds: nonProd.map((c) => c.id), envTag: null },
    skippedProdCount: prod.length,
    prodHostIds: prod.map((c) => c.id),
  };
}
