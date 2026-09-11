import type { DiscoveryScope } from "../ipc/bindings";
import { isProdEnvTag } from "./envTag";

export type DiscoverySkipResult = { skipped: true; reason: "prod" | "cancelled" | "no-owner" };

export { isProdEnvTag };

export function isDiscoverySkip(value: unknown): value is DiscoverySkipResult {
  if (!value || typeof value !== "object") return false;
  const rec = value as { skipped?: unknown; reason?: unknown };
  return (
    rec.skipped === true &&
    (rec.reason === "prod" || rec.reason === "cancelled" || rec.reason === "no-owner")
  );
}

/**
 * probe 归属判定（纯函数，可单测）：
 * - `kernel`：无任何清单声明该 probeId（如 `ssh-docker`），由内核拥有，直接跑；
 * - `owned`：至少一个已激活插件在 `contributes.discovery[]` 中声明；
 * - `no-owner`：有声明但无激活拥有者——调用方应跳过，不跑只能产出 unsupported 行的内核逻辑。
 */
export type ProbeOwnership = "kernel" | "owned" | "no-owner";

export function resolveProbeOwnership(
  probeId: string,
  declarations: Array<{ id: string; activated: boolean; probeIds: string[] }>,
): ProbeOwnership {
  const declarants = declarations.filter((d) => d.probeIds.includes(probeId));
  if (declarants.length === 0) return "kernel";
  return declarants.some((d) => d.activated) ? "owned" : "no-owner";
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
