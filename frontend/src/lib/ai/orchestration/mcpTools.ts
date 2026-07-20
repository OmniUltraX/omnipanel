import type { BuiltinToolRegistration } from "../context";
import { optionalString } from "../mcpToolArgs";
import { useConnectionStore } from "../../../stores/connectionStore";
import { useWorkspaceMembershipStore } from "../../../stores/workspaceMembershipStore";
import { useAiStore } from "../../../stores/aiStore";
import {
  genAiTaskId,
  useAiOrchestrationStore,
} from "../../../stores/aiOrchestrationStore";
import { followAiIntent } from "../uiFollow";
import { useBackgroundTaskStore } from "../../../stores/backgroundTaskStore";
import { SSH_MODULE_TOOLS } from "../../../modules/server/ssh/ai/mcpTools";

const CONCURRENCY = 4;

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  shouldAbort: () => boolean,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      if (shouldAbort()) return;
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  const n = Math.min(limit, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function resolveSshHosts(workspaceId: string | null): { id: string; name: string }[] {
  const all = useConnectionStore.getState().connections.filter((c) => c.kind === "ssh");
  if (!workspaceId) {
    return all.map((c) => ({ id: c.id, name: c.name }));
  }
  const members = new Set(
    useWorkspaceMembershipStore.getState().getWorkspaceResourceIds(workspaceId),
  );
  if (members.size === 0) {
    return all.map((c) => ({ id: c.id, name: c.name }));
  }
  return all.filter((c) => members.has(c.id)).map((c) => ({ id: c.id, name: c.name }));
}

async function fetchHostStats(connectionId: string): Promise<string> {
  const tool = SSH_MODULE_TOOLS.find((t) => t.name === "omni_ssh_get_stats");
  if (!tool) throw new Error("omni_ssh_get_stats 未注册");
  const out = await tool.handler({ resource_id: connectionId });
  return typeof out === "string" ? out : JSON.stringify(out);
}

async function sshFleetHealthCheck(args: Record<string, unknown>) {
  const pinned = useAiStore.getState().conversations.find(
    (c) => c.id === useAiStore.getState().activeConversationId,
  )?.pinnedWorkspaceId;
  const workspaceId = optionalString(args, "workspace_id") ?? pinned ?? null;
  const hosts = resolveSshHosts(workspaceId);
  if (hosts.length === 0) {
    return JSON.stringify({ ok: false, error: "未找到 SSH 主机" });
  }

  const parentId = genAiTaskId("ssh_health");
  const children = hosts.map((h) => ({
    id: `${parentId}_${h.id}`,
    title: h.name,
    status: "pending" as const,
    resourceId: h.id,
  }));

  useAiOrchestrationStore.getState().createTask({
    id: parentId,
    conversationId: useAiStore.getState().activeConversationId,
    title: workspaceId
      ? `SSH 体检（工作区）· ${hosts.length} 台`
      : `SSH 体检（全局）· ${hosts.length} 台`,
    kind: "sshFleetHealth",
    children,
  });

  const bg = useBackgroundTaskStore.getState();
  bg.upsertTask({
    id: parentId,
    module: "ai",
    kind: "aiOrchestration",
    title: `SSH 体检 · ${hosts.length} 台`,
    progress: `0 / ${hosts.length}`,
    status: "running",
    index: 0,
    total: hosts.length,
    startedAt: Date.now(),
  });
  bg.setTaskListOpen(true);

  let done = 0;
  let failed = 0;
  const reports: { host: string; id: string; ok: boolean; stats?: string; error?: string }[] =
    [];

  const aborted = () =>
    useAiOrchestrationStore.getState().tasks[parentId]?.status === "cancelled";

  await mapPool(
    hosts,
    CONCURRENCY,
    async (host) => {
      if (aborted()) return;
      useAiOrchestrationStore.getState().updateChild(parentId, `${parentId}_${host.id}`, {
        status: "running",
      });
      followAiIntent({ type: "openConnection", module: "ssh", resourceId: host.id });
      try {
        const stats = await fetchHostStats(host.id);
        reports.push({ host: host.name, id: host.id, ok: true, stats });
        useAiOrchestrationStore.getState().updateChild(parentId, `${parentId}_${host.id}`, {
          status: "completed",
          summary: "已采集资源占用",
        });
      } catch (e) {
        failed += 1;
        const message = e instanceof Error ? e.message : String(e);
        reports.push({ host: host.name, id: host.id, ok: false, error: message });
        useAiOrchestrationStore.getState().updateChild(parentId, `${parentId}_${host.id}`, {
          status: "failed",
          error: message,
        });
      } finally {
        done += 1;
        useBackgroundTaskStore.getState().upsertTask({
          id: parentId,
          module: "ai",
          kind: "aiOrchestration",
          title: `SSH 体检 · ${hosts.length} 台`,
          progress: `${done} / ${hosts.length}`,
          status: done >= hosts.length ? "completed" : "running",
          index: done,
          total: hosts.length,
          startedAt:
            useAiOrchestrationStore.getState().tasks[parentId]?.startedAt ?? Date.now(),
          finishedAt: done >= hosts.length ? Date.now() : null,
          error: failed > 0 ? `${failed} 台失败` : null,
        });
      }
    },
    aborted,
  );

  if (aborted()) {
    useAiOrchestrationStore.getState().setParentStatus(parentId, "cancelled");
    return JSON.stringify({ ok: false, cancelled: true, taskId: parentId });
  }

  const summary = {
    ok: true,
    taskId: parentId,
    scope: workspaceId ? "workspace" : "global",
    workspaceId,
    total: hosts.length,
    failed,
    reports,
    hint: "请根据各主机 stats 给出资源占用概览与优化建议；高负载主机优先。",
  };
  useAiOrchestrationStore
    .getState()
    .setParentStatus(
      parentId,
      failed === hosts.length ? "failed" : "completed",
      `失败 ${failed}/${hosts.length}`,
    );
  return JSON.stringify(summary, null, 2);
}

export const ORCHESTRATION_MODULE_TOOLS: BuiltinToolRegistration[] = [
  {
    name: "omni_orchestration_ssh_fleet_health",
    description:
      "对全部（或指定工作区内）SSH 主机扇出采集资源占用（CPU/内存等），返回汇总供你给出优化建议。适合「给所有 SSH 做体检」类请求；会在后台任务与会话任务树显示进度。可选 workspace_id；省略时若会话钉了工作区则用钉住范围，否则全局。",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: {
          type: "string",
          description: "可选；限定工作区 membership。省略=会话钉住或全局",
        },
      },
    },
    handler: sshFleetHealthCheck,
  },
];
