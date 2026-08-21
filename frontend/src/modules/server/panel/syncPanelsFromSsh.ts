import { commands, type Connection, type PanelProbeItem } from "@/ipc/bindings";
import { formatIpcError, unwrapCommand } from "@/ipc/result";
import {
  registerLocalBackgroundTaskCancel,
  upsertLocalBackgroundTask,
  useBackgroundTaskStore,
  type BackgroundTaskInfo,
} from "@/stores/backgroundTaskStore";
import {
  buildPanelConnection,
  parsePanelConfig,
  parseSshConfig,
} from "./serverConnection";
import { panelProbeReachableAddress } from "./panelAddress";

export type SyncPanelsFromSshProgress = {
  total: number;
  current: number;
  hostName: string;
};

export type SyncPanelsFromSshResult = {
  added: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
  taskId: string;
};

type SaveConn = (draft: Connection) => Promise<Connection | null | undefined>;

function findPanelForSshAndType(
  connections: Connection[],
  sshId: string,
  serviceType: "bt" | "1panel",
): Connection | undefined {
  return connections.find((c) => {
    if (c.kind !== "panel") return false;
    const cfg = parsePanelConfig(c);
    return cfg.sshConnectionId === sshId && cfg.serviceType === serviceType;
  });
}

/** 优先公网 IP，其次 SSH host，替换探测结果中的 127.0.0.1；API 地址不含安全入口。 */
function realPanelAddress(panel: PanelProbeItem, ssh: Connection): string {
  return panelProbeReachableAddress(panel, ssh);
}

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

/**
 * 遍历全部 SSH 主机，探测宝塔 / 1Panel，自动开启 API（如需）并写入面板连接。
 * 进度写入左下角后台任务（可取消）。
 */
export async function syncPanelsFromSshConnections(options: {
  connections: Connection[];
  saveConn: SaveConn;
  onProgress?: (progress: SyncPanelsFromSshProgress) => void;
  enableApiIfNeeded?: boolean;
}): Promise<SyncPanelsFromSshResult> {
  const { connections, saveConn, onProgress, enableApiIfNeeded = true } = options;
  const sshList = connections.filter((c) => c.kind === "ssh");
  let latest = [...connections];
  const result: SyncPanelsFromSshResult = {
    added: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
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
      title: "从 SSH 同步面板",
      status: "running",
      progress: sshList.length === 0 ? "无 SSH 主机" : `准备同步 ${sshList.length} 台主机…`,
      index: 0,
      total: Math.max(sshList.length, 1),
      startedAt,
    }),
  );

  try {
    if (sshList.length === 0) {
      upsertLocalBackgroundTask(
        makeTask({
          id: result.taskId,
          title: "从 SSH 同步面板",
          status: "completed",
          progress: "暂无 SSH 连接",
          index: 0,
          total: 1,
          startedAt,
          finishedAt: Date.now(),
        }),
      );
      return result;
    }

    let index = 0;
    for (const ssh of sshList) {
      if (cancelled) break;
      index += 1;
      onProgress?.({
        total: sshList.length,
        current: index,
        hostName: ssh.name || ssh.id,
      });
      upsertLocalBackgroundTask(
        makeTask({
          id: result.taskId,
          title: "从 SSH 同步面板",
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
        result.skipped += 1;
        result.errors.push(`${ssh.name || ssh.id}: 缺少主机地址`);
        continue;
      }

      try {
        const probe = await unwrapCommand(commands.sshPoolProbePanels(ssh.id));
        if (cancelled) break;
        const installed = (Array.isArray(probe.panels) ? probe.panels : []).filter(
          (p) => p?.installed,
        );
        if (installed.length === 0) {
          result.skipped += 1;
          continue;
        }

        for (const panel of installed) {
          if (cancelled) break;
          let apiKey = (panel.apiKey || "").trim();
          const apiEnabled = Boolean(panel.apiEnabled);

          if ((!apiEnabled || !apiKey) && enableApiIfNeeded) {
            upsertLocalBackgroundTask(
              makeTask({
                id: result.taskId,
                title: "从 SSH 同步面板",
                status: "running",
                progress: `${ssh.name}：开启 ${panel.kind} API…`,
                index,
                total: sshList.length,
                startedAt,
              }),
            );
            try {
              const enabled = await unwrapCommand(
                commands.sshPoolEnablePanelApi(ssh.id, panel.kind, true),
              );
              if (enabled.apiKey?.trim()) {
                apiKey = enabled.apiKey.trim();
              }
            } catch (err) {
              result.errors.push(
                `${ssh.name} · ${panel.kind}: 开启 API 失败 — ${formatIpcError(err)}`,
              );
            }
          }

          const serviceType = panel.kind === "bt" ? "bt" : "1panel";
          const typeLabel = serviceType === "bt" ? "宝塔" : "1Panel";
          let addr = realPanelAddress(panel, ssh);
          if (!addr || panel.port === 0) {
            result.failed += 1;
            result.errors.push(
              `${ssh.name} · ${typeLabel}: 无法解析面板地址/端口（请在主机执行 1pctl user-info 核对）`,
            );
            continue;
          }
          if (!apiKey) {
            result.failed += 1;
            result.errors.push(`${ssh.name} · ${typeLabel}: 未获取到 API Key，已跳过保存`);
            continue;
          }

          const linkedSameType = findPanelForSshAndType(latest, ssh.id, serviceType);
          const form = {
            name:
              ssh.name && ssh.name.trim()
                ? `${ssh.name} · ${typeLabel}`
                : `${sshHost} · ${typeLabel}`,
            group: ssh.group || "默认",
            host: sshHost,
            port: String(cfg?.port ?? 22),
            user: cfg?.user ?? "root",
            authType: "password" as const,
            password: "",
            pem: "",
            keyPath: "auto",
            passphrase: "",
            panelAddress: addr,
            panelKey: apiKey,
            serviceType: serviceType as "bt" | "1panel",
            remark: "",
          };

          const draft = buildPanelConnection(
            form,
            ssh.group || "默认",
            ssh.id,
            linkedSameType?.id,
            linkedSameType?.createdAt ?? undefined,
          );

          const saved = await saveConn(draft);
          if (!saved?.id) {
            result.failed += 1;
            result.errors.push(`${ssh.name} · ${typeLabel}: 保存失败`);
            continue;
          }

          latest = [...latest.filter((c) => c.id !== saved.id), saved];
          if (linkedSameType) result.updated += 1;
          else result.added += 1;
        }
      } catch (err) {
        result.failed += 1;
        result.errors.push(`${ssh.name || ssh.id}: ${formatIpcError(err)}`);
      } finally {
        try {
          await unwrapCommand(commands.sshPoolRelease(ssh.id));
        } catch {
          // ignore
        }
      }
    }

    const finishedAt = Date.now();
    if (cancelled) {
      upsertLocalBackgroundTask(
        makeTask({
          id: result.taskId,
          title: "从 SSH 同步面板",
          status: "cancelled",
          progress: `已取消 · 新增 ${result.added}，更新 ${result.updated}`,
          index,
          total: sshList.length,
          startedAt,
          finishedAt,
        }),
      );
    } else {
      const summary = `新增 ${result.added}，更新 ${result.updated}，跳过 ${result.skipped}，失败 ${result.failed}`;
      upsertLocalBackgroundTask(
        makeTask({
          id: result.taskId,
          title: "从 SSH 同步面板",
          status: result.failed > 0 && result.added + result.updated === 0 ? "failed" : "completed",
          progress: summary,
          index: sshList.length,
          total: sshList.length,
          startedAt,
          finishedAt,
          error:
            result.failed > 0 && result.added + result.updated === 0
              ? result.errors.slice(0, 2).join("；")
              : null,
        }),
      );
    }
  } catch (err) {
    upsertLocalBackgroundTask(
      makeTask({
        id: result.taskId,
        title: "从 SSH 同步面板",
        status: "failed",
        progress: formatIpcError(err),
        index: 0,
        total: Math.max(sshList.length, 1),
        startedAt,
        finishedAt: Date.now(),
        error: formatIpcError(err),
      }),
    );
    throw err;
  } finally {
    unregisterCancel();
  }

  return result;
}
