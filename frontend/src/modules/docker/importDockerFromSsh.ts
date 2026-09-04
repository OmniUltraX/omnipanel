/**
 * 从 SSH 主机导入 Docker：
 * 弹窗中由用户勾选主机并指定连接方式（SSH Engine / 1Panel / 宝塔）；
 * 确认后按选定方式写入；已绑定该 SSH 的 Docker 连接则跳过。
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
import { appendPanelEntrance, panelProbeReachableAddress } from "../server/panel/panelAddress";
import { isUsablePanelApiKey } from "../server/panel/panelApiKey";
import type { DiscoveryPreviewRow } from "@/components/ui/DiscoveryImportDialog";
import { createPluginHost, KERNEL_DOCKER_PLUGIN_ID } from "@/lib/pluginHost";
import { isProdEnvTag } from "@/lib/envTag";
import { isPluginActivated } from "@/stores/pluginRuntimeStore";
import { PLUGIN_ID_PANEL_1PANEL, PLUGIN_ID_PANEL_BT } from "../server/panel/panelPlugin";

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
  /** 本次成功写入的 Docker 连接 id，供导入后刷新侧栏缓存 */
  addedIds: string[];
};

/** 弹窗中用户为每台 SSH 选定的 Docker 连接方式（不先探测）。 */
export type DockerImportSshSource = "ssh-engine" | "onepanel" | "btpanel";

export type DockerImportSshSelection = {
  sshConnectionId: string;
  source: DockerImportSshSource;
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

/** 优先公网 IP，其次 SSH host，替换探测结果中的 127.0.0.1，并拼接安全入口。 */
function realPanelAddress(panel: PanelProbeItem, ssh: Connection): string {
  return appendPanelEntrance(panelProbeReachableAddress(panel, ssh), panel.entrance);
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
  if ((panel.apiEnabled && isUsablePanelApiKey(panel.kind, apiKey)) || !enableApiIfNeeded) {
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
 * 按用户在弹窗中选定的 SSH + 连接方式导入（确认后才探测面板/API Key）。
 * 进度写入左下角后台任务（可取消）。
 */
export async function importDockerFromSshSelections(options: {
  connections: Connection[];
  selections: DockerImportSshSelection[];
  saveConn: SaveConn;
  onProgress?: (progress: ImportDockerFromSshProgress) => void;
  enableApiIfNeeded?: boolean;
}): Promise<ImportDockerFromSshResult> {
  const { connections, selections, saveConn, onProgress, enableApiIfNeeded = true } = options;
  const sshById = new Map(connections.filter((c) => c.kind === "ssh").map((c) => [c.id, c]));
  const workList = selections
    .map((sel) => {
      const ssh = sshById.get(sel.sshConnectionId);
      return ssh ? { ssh, source: sel.source } : null;
    })
    .filter((entry): entry is { ssh: Connection; source: DockerImportSshSource } => Boolean(entry));

  let latest = [...connections];
  const result: ImportDockerFromSshResult = {
    added: 0,
    skipped: 0,
    failed: 0,
    noDocker: 0,
    errors: [],
    taskId: `import-docker-ssh-${Date.now()}`,
    addedIds: [],
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
      progress: workList.length === 0 ? "未选择主机" : `准备导入 ${workList.length} 台主机…`,
      index: 0,
      total: Math.max(workList.length, 1),
      startedAt,
    }),
  );

  try {
    if (workList.length === 0) {
      upsertLocalBackgroundTask(
        makeTask({
          id: result.taskId,
          title: "一键导入 Docker",
          status: "completed",
          progress: "未选择主机",
          index: 0,
          total: 1,
          startedAt,
          finishedAt: Date.now(),
        }),
      );
      return result;
    }

    let index = 0;
    for (const { ssh, source } of workList) {
      if (cancelled) break;
      index += 1;
      const hostLabel = ssh.name || ssh.id;
      onProgress?.({ total: workList.length, current: index, hostName: hostLabel });
      upsertLocalBackgroundTask(
        makeTask({
          id: result.taskId,
          title: "一键导入 Docker",
          status: "running",
          progress: `正在导入：${hostLabel}`,
          index,
          total: workList.length,
          startedAt,
        }),
      );

      if (findDockerBoundToSsh(latest, ssh.id)) {
        result.skipped += 1;
        continue;
      }

      const dockerName = `Docker - ${hostLabel}`;
      const dockerId = `docker-bound-${ssh.id}`;

      try {
        if (source === "ssh-engine") {
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
            result.addedIds.push(saved.id);
          }
          continue;
        }

        const panelKind = source === "onepanel" ? "1panel" : "bt";
        const panelLabel = source === "onepanel" ? "1Panel" : "宝塔";
        upsertLocalBackgroundTask(
          makeTask({
            id: result.taskId,
            title: "一键导入 Docker",
            status: "running",
            progress: `${hostLabel}：探测 ${panelLabel}…`,
            index,
            total: workList.length,
            startedAt,
          }),
        );
        const probe = await unwrapCommand(commands.sshPoolProbePanels(ssh.id));
        if (cancelled) break;
        const panels = (Array.isArray(probe.panels) ? probe.panels : []).filter((p) => p?.installed);
        const panel = panels.find((p) => p.kind === panelKind);
        if (!panel) {
          result.failed += 1;
          result.errors.push(`${hostLabel} · ${panelLabel}: 未检测到已安装的面板`);
          continue;
        }

        upsertLocalBackgroundTask(
          makeTask({
            id: result.taskId,
            title: "一键导入 Docker",
            status: "running",
            progress: `${hostLabel}：准备 ${panelLabel} API…`,
            index,
            total: workList.length,
            startedAt,
          }),
        );
        const apiKey = await resolvePanelApiKey(ssh.id, panel, enableApiIfNeeded);
        if (!apiKey) {
          result.failed += 1;
          result.errors.push(`${hostLabel} · ${panelLabel}: 未获取到 API Key`);
          continue;
        }
        const addr = realPanelAddress(panel, ssh);
        if (!addr || panel.port === 0) {
          result.failed += 1;
          result.errors.push(`${hostLabel} · ${panelLabel}: 无法解析面板地址`);
          continue;
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
          result.failed += 1;
          result.errors.push(`${hostLabel}: 保存失败`);
        } else {
          latest = [...latest.filter((c) => c.id !== saved.id), saved];
          result.added += 1;
          result.addedIds.push(saved.id);
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
          total: workList.length,
          startedAt,
          finishedAt,
        }),
      );
    } else {
      const summary = `新增 ${result.added}，跳过 ${result.skipped}，失败 ${result.failed}`;
      upsertLocalBackgroundTask(
        makeTask({
          id: result.taskId,
          title: "一键导入 Docker",
          status: result.failed > 0 && result.added === 0 ? "failed" : "completed",
          progress: summary,
          index: workList.length,
          total: workList.length,
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
        total: Math.max(workList.length, 1),
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
