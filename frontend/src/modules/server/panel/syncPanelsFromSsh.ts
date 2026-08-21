import { commands, type Connection } from "@/ipc/bindings";
import { formatIpcError, unwrapCommand } from "@/ipc/result";
import type { DiscoveryPreviewRow } from "@/components/ui/DiscoveryImportDialog";
import { panelProbeToPreviewRow } from "@/lib/panelDiscovery";
import { createPluginHost, findExistingCandidate } from "@/lib/pluginHost";
import { isProdEnvTag } from "@/lib/envTag";
import { useConnectionStore } from "@/stores/connectionStore";
import {
  registerLocalBackgroundTaskCancel,
  upsertLocalBackgroundTask,
  useBackgroundTaskStore,
  type BackgroundTaskInfo,
} from "@/stores/backgroundTaskStore";
import { parseSshConfig } from "./serverConnection";
import { panelProbeReachableAddress } from "./panelAddress";

export type SyncPanelsFromSshProgress = {
  total: number;
  current: number;
  hostName: string;
};

export type ProbePanelsFromSshResult = {
  rows: DiscoveryPreviewRow[];
  errors: string[];
  taskId: string;
};

export type SyncPanelsFromSshResult = {
  added: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
  taskId: string;
};

function makeTask(
  partial: Partial<BackgroundTaskInfo> &
    Pick<BackgroundTaskInfo, "id" | "title" | "status" | "startedAt">,
): BackgroundTaskInfo {
  return {
    module: "server",
    kind: "sync-panels-from-ssh",
    progress: "",
    index: 0,
    total: 0,
    rowCompleted: null,
    rowTotal: null,
    finishedAt: null,
    error: null,
    ...partial,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * 仅探测：SSH 扫面板 → Candidate。不开启 API、不写入。
 */
export async function probePanelCandidatesFromSsh(options: {
  connections: Connection[];
  hostIds?: string[];
  onProgress?: (progress: SyncPanelsFromSshProgress) => void;
  isCancelled?: () => boolean;
}): Promise<ProbePanelsFromSshResult> {
  const allowed = new Set(options.hostIds ?? []);
  const sshList = options.connections.filter((c) => {
    if (c.kind !== "ssh") return false;
    if (allowed.size > 0) return allowed.has(c.id);
    return !isProdEnvTag(c.envTag);
  });
  const result: ProbePanelsFromSshResult = {
    rows: [],
    errors: [],
    taskId: `sync-panels-ssh-${Date.now()}`,
  };
  const startedAt = Date.now();
  let cancelled = false;
  const unregisterCancel = registerLocalBackgroundTaskCancel(result.taskId, () => {
    cancelled = true;
  });
  useBackgroundTaskStore.getState().setTaskListOpen(true);
  upsertLocalBackgroundTask(
    makeTask({
      id: result.taskId,
      title: "从 SSH 探测面板",
      status: "running",
      progress: sshList.length === 0 ? "无 SSH 主机" : `准备探测 ${sshList.length} 台主机…`,
      index: 0,
      total: Math.max(sshList.length, 1),
      startedAt,
    }),
  );

  try {
    let index = 0;
    for (const ssh of sshList) {
      if (cancelled || options.isCancelled?.()) {
        cancelled = true;
        break;
      }
      index += 1;
      options.onProgress?.({
        total: sshList.length,
        current: index,
        hostName: ssh.name || ssh.id,
      });
      upsertLocalBackgroundTask(
        makeTask({
          id: result.taskId,
          title: "从 SSH 探测面板",
          status: "running",
          progress: `正在探测：${ssh.name || ssh.id}`,
          index,
          total: sshList.length,
          startedAt,
        }),
      );
      const cfg = parseSshConfig(ssh);
      const sshHost = (cfg?.publicIp || cfg?.host || "").trim();
      if (!sshHost) {
        result.errors.push(`${ssh.name || ssh.id}: 缺少主机地址`);
        continue;
      }
      try {
        const probe = await unwrapCommand(commands.sshPoolProbePanels(ssh.id));
        if (cancelled || options.isCancelled?.()) {
          cancelled = true;
          break;
        }
        const installed = (Array.isArray(probe.panels) ? probe.panels : []).filter((p) => p?.installed);
        for (const panel of installed) {
          const address = panelProbeReachableAddress(panel, ssh);
          const row = panelProbeToPreviewRow({
            ssh,
            panel,
            address,
            connections: options.connections,
          });
          if (row) result.rows.push(row);
        }
      } catch (err) {
        result.errors.push(`${ssh.name || ssh.id}: ${formatIpcError(err)}`);
      } finally {
        try {
          await unwrapCommand(commands.sshPoolRelease(ssh.id));
        } catch {
          // ignore
        }
      }
    }
    upsertLocalBackgroundTask(
      makeTask({
        id: result.taskId,
        title: "从 SSH 探测面板",
        status: cancelled ? "cancelled" : "completed",
        progress: `发现 ${result.rows.length} 条候选`,
        index: sshList.length,
        total: Math.max(sshList.length, 1),
        startedAt,
        finishedAt: Date.now(),
      }),
    );
  } finally {
    unregisterCancel();
  }
  return result;
}

/** 预览确认后：必要时开启 API，再经 Host API upsert。 */
export async function importPanelPreviewRows(
  rows: DiscoveryPreviewRow[],
): Promise<SyncPanelsFromSshResult> {
  const result: SyncPanelsFromSshResult = {
    added: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    taskId: `import-panels-${Date.now()}`,
  };
  for (const row of rows) {
    if (row.status === "unsupported") {
      result.skipped += 1;
      continue;
    }
    if (row.status === "duplicate") {
      result.skipped += 1;
      continue;
    }
    const cfg = asRecord(row.candidate.config);
    const sshId = typeof cfg.sshConnectionId === "string" ? cfg.sshConnectionId : row.candidate.accountId;
    const probeKind = typeof cfg.probeKind === "string" ? cfg.probeKind : "";
    let apiKey = typeof cfg.key === "string" ? cfg.key.trim() : "";
    if (sshId && probeKind && !apiKey) {
      try {
        const enabled = await unwrapCommand(commands.sshPoolEnablePanelApi(sshId, probeKind, true));
        if (enabled.apiKey?.trim()) apiKey = enabled.apiKey.trim();
      } catch (err) {
        result.failed += 1;
        result.errors.push(`${row.label}: 开启 API 失败 — ${formatIpcError(err)}`);
        continue;
      }
    }
    if (!apiKey) {
      result.failed += 1;
      result.errors.push(`${row.label}: 未获取到 API Key`);
      continue;
    }
    try {
      const connections = useConnectionStore.getState().connections;
      const existing = findExistingCandidate(connections, {
        ...row.candidate,
        config: { ...cfg, key: apiKey },
      });
      const host = createPluginHost(row.candidate.pluginId);
      await host.connections.upsert({
        ...row.candidate,
        config: { ...cfg, key: apiKey },
      });
      if (existing) result.updated += 1;
      else result.added += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push(`${row.label}: ${formatIpcError(err)}`);
    }
  }
  return result;
}
