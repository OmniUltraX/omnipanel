import { listen } from "@tauri-apps/api/event";
import { commands } from "../ipc/bindings";
import { PLUGIN_DISCOVERY_CANCELLED } from "../ipc/events";
import { unwrapCommand } from "../ipc/result";
import type { DiscoveryScope } from "../ipc/bindings";
import type { DiscoveryPreviewRow } from "../components/ui/DiscoveryImportDialog";
import { useBackgroundTaskStore } from "../stores/backgroundTaskStore";
import { useConnectionStore } from "../stores/connectionStore";
import { isPluginActivated } from "../stores/pluginRuntimeStore";
import { listPluginManifests } from "./pluginManifests";
import { isProdEnvTag } from "./envTag";
import type { DiscoverySkipResult } from "./discoveryScope";
import { resolveProbeOwnership } from "./discoveryScope";

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

export type { ProbeOwnership } from "./discoveryScope";

/** 当前已激活的 probe 拥有者（插件 id 列表）。 */
export function listProbeOwnerIds(probeId: string): string[] {
  return listPluginManifests()
    .filter((m) => (m.contributes.discovery ?? []).some((d) => d.probeId === probeId))
    .filter((m) => isPluginActivated(m.id))
    .map((m) => m.id);
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
  if (isProdEnvTag(scope.envTag)) {
    return { skipped: true, reason: "prod" } satisfies DiscoverySkipResult;
  }
  // 插件声明拥有的 probe，无激活拥有者时直接跳过（禁用面板插件后 ssh-panel 不再空跑；
  // 判定位于 discoveryRun 之前，不建多余的后端任务）。
  const declarations = listPluginManifests().map((m) => ({
    id: m.id,
    activated: isPluginActivated(m.id),
    probeIds: (m.contributes.discovery ?? []).map((d) => d.probeId),
  }));
  if (resolveProbeOwnership(probeId, declarations) === "no-owner") {
    return { skipped: true, reason: "no-owner" } satisfies DiscoverySkipResult;
  }
  const taskId = await unwrapCommand(commands.discoveryRun(probeId, scope));
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

registerDiscoveryProbe("module-http", async (scope, ctx) => {
  const { probeModuleHttpCandidates } = await import("../modules/plugin-module/moduleDiscovery");
  return probeModuleHttpCandidates(scope, ctx);
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
