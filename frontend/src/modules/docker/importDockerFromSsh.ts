/**
 * 从 SSH 主机一键导入 Docker：
 * 优先级 1Panel > 宝塔 > 裸 Docker Engine；同一 SSH 只导入一种；
 * 任一面板存在但无 Docker 时不回退裸 Engine；已绑定该 SSH 的 Docker 连接则跳过。
 * 可通过 `sshConnectionIds` 限定扫描范围（未传则扫描全部 SSH）。
 */
import { commands, type Connection, type PanelProbeItem } from "@/ipc/bindings";
import { formatIpcError, unwrapCommand } from "@/ipc/result";
import {
  registerLocalBackgroundTaskCancel,
  upsertLocalBackgroundTask,
  useBackgroundTaskStore,
  type BackgroundTaskInfo,
} from "@/stores/backgroundTaskStore";
import { parseSshConfig } from "../server/panel/serverConnection";
import { panelProbeReachableAddress } from "../server/panel/panelAddress";
import type { DiscoveryPreviewRow } from "@/components/ui/DiscoveryImportDialog";
import { createPluginHost, KERNEL_DOCKER_PLUGIN_ID } from "@/lib/pluginHost";
import { isProdEnvTag } from "@/lib/envTag";
import { isPluginActivated } from "@/stores/pluginRuntimeStore";
import { PLUGIN_ID_PANEL_1PANEL } from "../../../../plugins/panel-1panel/src/mapProbe";
import { PLUGIN_ID_PANEL_BT } from "../../../../plugins/panel-bt/src/mapProbe";

export type ImportDockerFromSshProgress = {
  total: number;
  current: number;
  hostName: string;
};

export type ImportDockerFromSshResult = {
  added: number;
  skipped: number;
  failed: number;
  noDocker: number;
  errors: string[];
  taskId: string;
};

type SaveConn = (draft: Connection) => Promise<Connection | null | undefined>;

export function findDockerBoundToSsh(connections: Connection[], sshId: string): Connection | undefined {
  return connections.find((c) => {
    if (c.kind !== "docker") return false;
    try {
      const cfg = JSON.parse(c.config || "{}") as { boundSshConnectionId?: string };
      return cfg.boundSshConnectionId === sshId;
    } catch {
      return false;
    }
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
    module: "docker",
    kind: "import-docker-from-ssh",
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

export function buildDockerDraft(opts: {
  id: string;
  name: string;
  source: "onepanel" | "btpanel" | "ssh-engine";
  ssh: Connection;
  panelBaseUrl?: string;
  panelApiKey?: string;
  panelInsecure?: boolean;
}): Connection {
  const sshCfg = parseSshConfig(opts.ssh);
  let config: Record<string, unknown>;

  if (opts.source === "onepanel") {
    config = {
      source: "onepanel",
      host: opts.panelBaseUrl ?? "",
      boundSshConnectionId: opts.ssh.id,
      autoScanned: true,
      onepanel: {
        baseUrl: opts.panelBaseUrl ?? "",
        apiKey: opts.panelApiKey ?? "",
        insecure: opts.panelInsecure ?? true,
      },
    };
  } else if (opts.source === "btpanel") {
    config = {
      source: "btpanel",
      host: opts.panelBaseUrl ?? "",
      boundSshConnectionId: opts.ssh.id,
      autoScanned: true,
      btpanel: {
        baseUrl: opts.panelBaseUrl ?? "",
        apiKey: opts.panelApiKey ?? "",
        insecure: opts.panelInsecure ?? true,
      },
    };
  } else {
    const ssh = sshCfg
      ? {
          host: sshCfg.host,
          port: sshCfg.port,
          user: sshCfg.user,
          auth: sshCfg.auth,
        }
      : undefined;
    config = {
      source: "ssh-engine",
      host: sshCfg ? `${sshCfg.user}@${sshCfg.host}:${sshCfg.port}` : opts.ssh.name,
      boundSshConnectionId: opts.ssh.id,
      autoScanned: true,
      ...(ssh ? { ssh } : {}),
    };
  }

  return {
    id: opts.id,
    kind: "docker",
    name: opts.name,
    group: "默认",
    envTag: "unknown",
    tags: [],
    config: JSON.stringify(config),
  };
}

async function resolvePanelApiKey(
  sshId: string,
  panel: PanelProbeItem,
  enableApiIfNeeded: boolean,
): Promise<string> {
  let apiKey = (panel.apiKey || "").trim();
  if ((panel.apiEnabled && apiKey) || !enableApiIfNeeded) {
    return apiKey;
  }
  try {
    const enabled = await unwrapCommand(commands.sshPoolEnablePanelApi(sshId, panel.kind, true));
    if (enabled.apiKey?.trim()) {
      apiKey = enabled.apiKey.trim();
    }
  } catch {
    // 调用方根据空 key 记失败
  }
  return apiKey;
}

/**
 * 遍历 SSH 主机，按 1Panel → 宝塔 → 裸 Docker 优先级导入。
 * 进度写入左下角后台任务（可取消）。
 */
export async function importDockerFromSshConnections(options: {
  connections: Connection[];
  saveConn: SaveConn;
  onProgress?: (progress: ImportDockerFromSshProgress) => void;
  enableApiIfNeeded?: boolean;
  /** 仅扫描这些 SSH 连接；未传则扫描全部 SSH */
  sshConnectionIds?: string[];
}): Promise<ImportDockerFromSshResult> {
  const { connections, saveConn, onProgress, enableApiIfNeeded = true, sshConnectionIds } = options;
  const idSet = sshConnectionIds ? new Set(sshConnectionIds) : null;
  const sshList = connections.filter((c) => {
    if (c.kind !== "ssh") return false;
    if (idSet && !idSet.has(c.id)) return false;
    return true;
  });
  let latest = [...connections];
  const result: ImportDockerFromSshResult = {
    added: 0,
    skipped: 0,
    failed: 0,
    noDocker: 0,
    errors: [],
    taskId: `import-docker-ssh-${Date.now()}`,
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
      title: "一键导入 Docker",
      status: "running",
      progress: sshList.length === 0 ? "无 SSH 主机" : `准备扫描 ${sshList.length} 台主机…`,
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
          title: "一键导入 Docker",
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
      const hostLabel = ssh.name || ssh.id;
      onProgress?.({ total: sshList.length, current: index, hostName: hostLabel });
      upsertLocalBackgroundTask(
        makeTask({
          id: result.taskId,
          title: "一键导入 Docker",
          status: "running",
          progress: `正在扫描：${hostLabel}`,
          index,
          total: sshList.length,
          startedAt,
        }),
      );

      if (findDockerBoundToSsh(latest, ssh.id)) {
        result.skipped += 1;
        continue;
      }

      try {
        const probe = await unwrapCommand(commands.sshPoolProbePanels(ssh.id));
        if (cancelled) break;
        const panels = (Array.isArray(probe.panels) ? probe.panels : []).filter((p) => p?.installed);
        const onePanel = panels.find((p) => p.kind === "1panel");
        const btPanel = panels.find((p) => p.kind === "bt");

        const dockerName = `Docker - ${hostLabel}`;
        const dockerId = `docker-bound-${ssh.id}`;

        const tryImportPanel = async (
          panel: PanelProbeItem,
          source: "onepanel" | "btpanel",
        ): Promise<"added" | "failed" | "no_docker"> => {
          const dockerProbe = await unwrapCommand(commands.dockerProbeSshDocker(ssh.id));
          if (!dockerProbe.available) {
            return "no_docker";
          }
          upsertLocalBackgroundTask(
            makeTask({
              id: result.taskId,
              title: "一键导入 Docker",
              status: "running",
              progress: `${hostLabel}：准备 ${source === "onepanel" ? "1Panel" : "宝塔"} API…`,
              index,
              total: sshList.length,
              startedAt,
            }),
          );
          let apiKey = await resolvePanelApiKey(ssh.id, panel, enableApiIfNeeded);
          if (!apiKey) {
            result.errors.push(
              `${hostLabel} · ${source === "onepanel" ? "1Panel" : "宝塔"}: 未获取到 API Key`,
            );
            return "failed";
          }
          const addr = realPanelAddress(panel, ssh);
          if (!addr || panel.port === 0) {
            result.errors.push(
              `${hostLabel} · ${source === "onepanel" ? "1Panel" : "宝塔"}: 无法解析面板地址`,
            );
            return "failed";
          }
          const draft = buildDockerDraft({
            id: dockerId,
            name: dockerName,
            source,
            ssh,
            panelBaseUrl: addr,
            panelApiKey: apiKey,
            panelInsecure: true,
          });
          const saved = await saveConn(draft);
          if (!saved?.id) {
            result.errors.push(`${hostLabel}: 保存失败`);
            return "failed";
          }
          latest = [...latest.filter((c) => c.id !== saved.id), saved];
          return "added";
        };

        if (onePanel) {
          const outcome = await tryImportPanel(onePanel, "onepanel");
          if (outcome === "added") result.added += 1;
          else if (outcome === "failed") result.failed += 1;
          else result.noDocker += 1;
          continue;
        }

        if (btPanel) {
          const outcome = await tryImportPanel(btPanel, "btpanel");
          if (outcome === "added") result.added += 1;
          else if (outcome === "failed") result.failed += 1;
          else result.noDocker += 1;
          continue;
        }

        // 两面板都不存在 → 裸 Docker
        const dockerProbe = await unwrapCommand(commands.dockerProbeSshDocker(ssh.id));
        if (!dockerProbe.available) {
          result.noDocker += 1;
          continue;
        }
        const draft = buildDockerDraft({
          id: dockerId,
          name: dockerName,
          source: "ssh-engine",
          ssh,
        });
        const saved = await saveConn(draft);
        if (!saved?.id) {
          result.failed += 1;
          result.errors.push(`${hostLabel}: 保存失败`);
        } else {
          latest = [...latest.filter((c) => c.id !== saved.id), saved];
          result.added += 1;
        }
      } catch (err) {
        result.failed += 1;
        result.errors.push(`${hostLabel}: ${formatIpcError(err)}`);
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
          title: "一键导入 Docker",
          status: "cancelled",
          progress: `已取消 · 新增 ${result.added}，跳过 ${result.skipped}`,
          index,
          total: sshList.length,
          startedAt,
          finishedAt,
        }),
      );
    } else {
      const summary = `新增 ${result.added}，跳过 ${result.skipped}，无 Docker ${result.noDocker}，失败 ${result.failed}`;
      upsertLocalBackgroundTask(
        makeTask({
          id: result.taskId,
          title: "一键导入 Docker",
          status: result.failed > 0 && result.added === 0 ? "failed" : "completed",
          progress: summary,
          index: sshList.length,
          total: sshList.length,
          startedAt,
          finishedAt,
          error:
            result.failed > 0 && result.added === 0
              ? result.errors.slice(0, 2).join("；")
              : null,
        }),
      );
    }
  } catch (err) {
    upsertLocalBackgroundTask(
      makeTask({
        id: result.taskId,
        title: "一键导入 Docker",
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

function dockerRow(opts: {
  ssh: Connection;
  source: "onepanel" | "btpanel" | "ssh-engine";
  pluginId: string;
  dockerConfig: Record<string, unknown>;
  host: string;
  duplicate: boolean;
  unsupported: boolean;
}): DiscoveryPreviewRow {
  const candidate = {
    pluginId: opts.pluginId,
    accountId: opts.ssh.id,
    remoteId: `${opts.ssh.id}:docker:${opts.source}`,
    remoteKind: "docker",
    name: `Docker - ${opts.ssh.name || opts.ssh.id}`,
    config: {
      id: `docker-bound-${opts.ssh.id}`,
      dockerConfig: opts.dockerConfig,
    },
  };
  const status = opts.unsupported ? "unsupported" : opts.duplicate ? "duplicate" : "importable";
  return {
    id: candidate.remoteId,
    candidate,
    label: candidate.name,
    kindLabel: opts.source,
    host: opts.host,
    status,
    disabled: opts.unsupported,
  };
}

/** 仅探测 Docker 候选，不写入。 */
export async function probeDockerCandidatesFromSsh(options: {
  connections: Connection[];
  hostIds?: string[];
  saveOnProbe?: boolean;
  isCancelled?: () => boolean;
}): Promise<{ probeId: string; rows: DiscoveryPreviewRow[]; errors: string[] }> {
  const allowed = new Set(options.hostIds ?? []);
  const sshList = options.connections.filter((c) => {
    if (c.kind !== "ssh") return false;
    if (allowed.size > 0) return allowed.has(c.id);
    return !isProdEnvTag(c.envTag);
  });
  const rows: DiscoveryPreviewRow[] = [];
  const errors: string[] = [];
  for (const ssh of sshList) {
    if (options.isCancelled?.()) break;
    const hostLabel = ssh.name || ssh.id;
    if (findDockerBoundToSsh(options.connections, ssh.id)) {
      rows.push(
        dockerRow({
          ssh,
          source: "ssh-engine",
          pluginId: KERNEL_DOCKER_PLUGIN_ID,
          dockerConfig: {},
          host: hostLabel,
          duplicate: true,
          unsupported: false,
        }),
      );
      continue;
    }
    try {
      const probe = await unwrapCommand(commands.sshPoolProbePanels(ssh.id));
      const panels = (Array.isArray(probe.panels) ? probe.panels : []).filter((p) => p?.installed);
      const onePanel = panels.find((p) => p.kind === "1panel");
      const btPanel = panels.find((p) => p.kind === "bt");
      const dockerProbe = await unwrapCommand(commands.dockerProbeSshDocker(ssh.id));
      if (!dockerProbe.available) {
        continue;
      }
      const tryPanel = (
        panel: NonNullable<typeof onePanel>,
        source: "onepanel" | "btpanel",
        pluginId: string,
      ) => {
        const addr = realPanelAddress(panel, ssh);
        const draft = buildDockerDraft({
          id: `docker-bound-${ssh.id}`,
          name: `Docker - ${hostLabel}`,
          source,
          ssh,
          panelBaseUrl: addr,
          panelApiKey: panel.apiKey,
          panelInsecure: true,
        });
        rows.push(
          dockerRow({
            ssh,
            source,
            pluginId,
            dockerConfig: JSON.parse(draft.config || "{}") as Record<string, unknown>,
            host: addr || hostLabel,
            duplicate: false,
            unsupported: !isPluginActivated(pluginId),
          }),
        );
      };
      if (onePanel && isPluginActivated(PLUGIN_ID_PANEL_1PANEL)) {
        tryPanel(onePanel, "onepanel", PLUGIN_ID_PANEL_1PANEL);
      } else if (btPanel && isPluginActivated(PLUGIN_ID_PANEL_BT)) {
        tryPanel(btPanel, "btpanel", PLUGIN_ID_PANEL_BT);
      } else {
        const draft = buildDockerDraft({
          id: `docker-bound-${ssh.id}`,
          name: `Docker - ${hostLabel}`,
          source: "ssh-engine",
          ssh,
        });
        rows.push(
          dockerRow({
            ssh,
            source: "ssh-engine",
            pluginId: KERNEL_DOCKER_PLUGIN_ID,
            dockerConfig: JSON.parse(draft.config || "{}") as Record<string, unknown>,
            host: hostLabel,
            duplicate: false,
            unsupported: false,
          }),
        );
      }
    } catch (err) {
      errors.push(`${hostLabel}: ${formatIpcError(err)}`);
    } finally {
      try {
        await unwrapCommand(commands.sshPoolRelease(ssh.id));
      } catch {
        // ignore
      }
    }
  }
  return { probeId: "ssh-docker", rows, errors };
}

export async function importDockerPreviewRows(
  rows: DiscoveryPreviewRow[],
): Promise<{ added: number; skipped: number; failed: number; errors: string[] }> {
  const result = { added: 0, skipped: 0, failed: 0, errors: [] as string[] };
  for (const row of rows) {
    if (row.status !== "importable") {
      result.skipped += 1;
      continue;
    }
    try {
      await createPluginHost(row.candidate.pluginId).connections.upsert(row.candidate);
      result.added += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push(`${row.label}: ${formatIpcError(err)}`);
    }
  }
  return result;
}
