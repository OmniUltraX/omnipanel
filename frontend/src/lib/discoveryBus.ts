import { listen } from "@tauri-apps/api/event";
import { commands } from "../ipc/bindings";
import { PLUGIN_DISCOVERY_CANCELLED } from "../ipc/events";
import { unwrapCommand } from "../ipc/result";
import type { DiscoveryScope } from "../ipc/bindings";
import type { DiscoveryPreviewRow } from "../components/ui/DiscoveryImportDialog";
import { useBackgroundTaskStore } from "../stores/backgroundTaskStore";
import { useConnectionStore } from "../stores/connectionStore";
import { isProdEnvTag } from "./envTag";
import type { DiscoverySkipResult } from "./discoveryScope";

export type DiscoveryProbeContext = {
  isCancelled: () => boolean;
};

export type DiscoveryProbeFn = (
  scope: DiscoveryScope,
  ctx?: DiscoveryProbeContext,
) => Promise<unknown>;

export type { DiscoverySkipResult };
export { isDiscoverySkip, isProdEnvTag, sshDiscoveryScope } from "./discoveryScope";

const probes = new Map<string, DiscoveryProbeFn>();

export function registerDiscoveryProbe(id: string, run: DiscoveryProbeFn): void {
  probes.set(id, run);
}

export function getDiscoveryProbe(id: string): DiscoveryProbeFn | undefined {
  return probes.get(id);
}

export type DiscoveryCandidates = {
  probeId: string;
  rows: DiscoveryPreviewRow[];
  errors: string[];
};

export function isDiscoveryTaskCancelled(taskId: string): boolean {
  const task = useBackgroundTaskStore.getState().tasks[taskId];
  return task?.status === "cancelled";
}

export async function watchDiscoveryCancellation(
  taskId: string,
  onCancel: () => void,
): Promise<() => void> {
  try {
    return await listen<{ taskId?: string }>(PLUGIN_DISCOVERY_CANCELLED, (event) => {
      if (event.payload?.taskId === taskId) onCancel();
    });
  } catch {
    return () => undefined;
  }
}

/** 先走任务中心 `discovery_run`，再执行已注册内核 probe；取消时停止产出候选。 */
export async function runDiscoveryProbe(
  probeId: string,
  scope: DiscoveryScope = { hostIds: [] },
): Promise<unknown> {
  const taskId = await unwrapCommand(commands.discoveryRun(probeId, scope));
  if (isProdEnvTag(scope.envTag)) {
    return { skipped: true, reason: "prod" } satisfies DiscoverySkipResult;
  }
  let cancelled = false;
  const unlisten = await watchDiscoveryCancellation(taskId, () => {
    cancelled = true;
  });
  const isCancelled = () => cancelled || isDiscoveryTaskCancelled(taskId);
  try {
    if (isCancelled()) {
      return { skipped: true, reason: "cancelled" } satisfies DiscoverySkipResult;
    }
    const probe = probes.get(probeId);
    if (!probe) return null;
    const result = await probe(scope, { isCancelled });
    if (isCancelled()) {
      return { skipped: true, reason: "cancelled" } satisfies DiscoverySkipResult;
    }
    return result;
  } finally {
    unlisten();
  }
}

registerDiscoveryProbe("ssh-docker", async (scope, ctx) => {
  const { probeDockerCandidatesFromSsh } = await import("../modules/docker/importDockerFromSsh");
  const store = useConnectionStore.getState();
  return probeDockerCandidatesFromSsh({
    connections: store.connections,
    hostIds: scope.hostIds,
    isCancelled: ctx?.isCancelled,
  });
});

registerDiscoveryProbe("ssh-panel", async (scope, ctx) => {
  const { probePanelCandidatesFromSsh } = await import("../modules/server/panel/syncPanelsFromSsh");
  const store = useConnectionStore.getState();
  const probed = await probePanelCandidatesFromSsh({
    connections: store.connections,
    hostIds: scope.hostIds,
    isCancelled: ctx?.isCancelled,
  });
  return {
    probeId: "ssh-panel",
    rows: probed.rows,
    errors: probed.errors,
  } satisfies DiscoveryCandidates;
});
