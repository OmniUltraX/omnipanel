import type { Connection, DockerConnectionInfo, DockerConnectionSource } from "@/ipc/bindings";
import { DOCKER_LOCAL_CONNECTION_ID } from "./constants";
import {
  isBtPanelDockerSource,
  isOnePanelDockerSource,
  normalizeDockerSource,
} from "./dockerConnectionSource";

/** 探测还没回来的连接。侧栏用「连接中」，不要先画成离线。 */
const pendingDockerProbeIds = new Set<string>();
/** 本会话已探测过的连接。未探测默认灰点，探测失败才红点。 */
const probedDockerConnectionIds = new Set<string>();

export function isDockerConnectionProbePending(connectionId: string): boolean {
  return pendingDockerProbeIds.has(connectionId);
}

export function markDockerProbePending(ids: readonly string[]): void {
  for (const id of ids) pendingDockerProbeIds.add(id);
}

export function clearDockerProbePending(ids: readonly string[]): void {
  for (const id of ids) pendingDockerProbeIds.delete(id);
}

export function clearAllDockerProbePending(): void {
  pendingDockerProbeIds.clear();
}

export function isDockerConnectionProbed(connectionId: string): boolean {
  return probedDockerConnectionIds.has(connectionId);
}

export function markDockerProbed(ids: readonly string[]): void {
  for (const id of ids) probedDockerConnectionIds.add(id);
}

export function clearDockerProbed(ids: readonly string[]): void {
  for (const id of ids) probedDockerConnectionIds.delete(id);
}

type StoredDockerConfig = {
  source?: string;
  host?: string;
  boundSshConnectionId?: string;
  ssh?: { user?: string; host?: string };
  onepanel?: { baseUrl?: string };
  btpanel?: { baseUrl?: string };
};

function parseStoredDockerConfig(config: string | undefined): StoredDockerConfig {
  if (!config) return {};
  try {
    const parsed = JSON.parse(config) as StoredDockerConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function toDockerSource(raw: string | undefined): DockerConnectionSource {
  const normalized = normalizeDockerSource(raw ?? "");
  if (normalized === "remote-engine") return "remote-engine";
  if (normalized === "ssh-engine") return "ssh-engine";
  if (isOnePanelDockerSource(normalized)) return "one-panel";
  if (isBtPanelDockerSource(normalized)) return "panel-adapter";
  if (normalized === "local-engine") return "local-engine";
  return "local-engine";
}

function hostLabelFromConfig(config: StoredDockerConfig, fallbackName: string): string {
  const host = config.host?.trim();
  if (host) return host;
  const ssh = config.ssh;
  if (ssh?.host) {
    const user = ssh.user?.trim();
    return user ? `${user}@${ssh.host}` : ssh.host;
  }
  const panel = config.onepanel?.baseUrl?.trim() || config.btpanel?.baseUrl?.trim();
  if (panel) return panel;
  return fallbackName;
}

/** 本地 Engine / 团队共享不在连接库里，列表合并时要留下来。 */
export function isEphemeralDockerConnectionId(connectionId: string): boolean {
  return connectionId === DOCKER_LOCAL_CONNECTION_ID || connectionId.startsWith("docker-mesh:");
}

/**
 * 连接库里误存的本机 Engine（引导向导曾落库「本机 Docker」）。
 * 正式入口是内置 `docker-local`，这些条目应过滤并交由后端清理。
 */
export function isRedundantStoredLocalDocker(connection: Connection): boolean {
  if (connection.kind !== "docker") return false;
  if (connection.id === DOCKER_LOCAL_CONNECTION_ID) return true;
  return toDockerSource(parseStoredDockerConfig(connection.config).source) === "local-engine";
}

/** 连接库里的 Docker 连接 → 侧栏节点。状态等探测回填。 */
export function dockerInfoFromStored(connection: Connection): DockerConnectionInfo {
  const config = parseStoredDockerConfig(connection.config);
  return {
    connectionId: connection.id,
    name: connection.name,
    source: toDockerSource(config.source),
    status: "offline",
    hostLabel: hostLabelFromConfig(config, connection.name),
    environment: connection.envTag?.trim() || "unknown",
    engineVersion: null,
    apiVersion: null,
    containersRunning: 0,
    containersTotal: 0,
    warningMessage: null,
    boundSshConnectionId: config.boundSshConnectionId?.trim() || null,
  };
}

function overlayStoredFields(
  probed: DockerConnectionInfo,
  stored: Connection,
): DockerConnectionInfo {
  const draft = dockerInfoFromStored(stored);
  if (
    probed.name === draft.name &&
    probed.source === draft.source &&
    probed.hostLabel === draft.hostLabel &&
    probed.environment === draft.environment &&
    probed.boundSshConnectionId === draft.boundSshConnectionId
  ) {
    return probed;
  }
  return {
    ...probed,
    name: draft.name,
    source: draft.source,
    hostLabel: draft.hostLabel,
    environment: draft.environment,
    boundSshConnectionId: draft.boundSshConnectionId,
  };
}

/**
 * 连接库一变就反映到侧栏，不等 `dockerListConnections` 把全部主机探测完。
 * 已有节点保留上次探测到的状态；新节点记为待探测。
 */
export function reconcileDockerConnections(
  prev: readonly DockerConnectionInfo[],
  stored: readonly Connection[],
): { connections: DockerConnectionInfo[]; addedIds: string[] } {
  const storedDocker = stored.filter(
    (item) => item.kind === "docker" && !isRedundantStoredLocalDocker(item),
  );
  const storedById = new Map(storedDocker.map((item) => [item.id, item]));
  const next: DockerConnectionInfo[] = [];
  const seen = new Set<string>();
  let changed = false;

  for (const item of prev) {
    if (isEphemeralDockerConnectionId(item.connectionId)) {
      next.push(item);
      seen.add(item.connectionId);
      continue;
    }
    const storedConn = storedById.get(item.connectionId);
    if (!storedConn) {
      changed = true;
      continue;
    }
    const overlaid = overlayStoredFields(item, storedConn);
    if (overlaid !== item) changed = true;
    next.push(overlaid);
    seen.add(item.connectionId);
  }

  const addedIds: string[] = [];
  for (const storedConn of storedDocker) {
    if (seen.has(storedConn.id)) continue;
    next.push(dockerInfoFromStored(storedConn));
    addedIds.push(storedConn.id);
    changed = true;
  }

  if (!changed && next.length === prev.length) {
    return { connections: prev as DockerConnectionInfo[], addedIds };
  }
  return { connections: next, addedIds };
}

/**
 * 合并连接目录。列表本身不再 probe：本会话已探测过的 online/degraded 状态要保留。
 * 探测期间新保存、还不在结果里的连接留在列表末尾。
 */
export function applyProbedDockerConnections(
  prev: readonly DockerConnectionInfo[],
  probed: readonly DockerConnectionInfo[],
  stored: readonly Connection[],
): DockerConnectionInfo[] {
  const prevById = new Map(prev.map((item) => [item.connectionId, item]));
  const storedById = new Map(
    stored
      .filter((item) => item.kind === "docker" && !isRedundantStoredLocalDocker(item))
      .map((item) => [item.id, item]),
  );
  const probedIds = new Set(probed.map((item) => item.connectionId));
  const merged = probed.map((item) => {
    const storedConn = storedById.get(item.connectionId);
    const overlaid = storedConn ? overlayStoredFields(item, storedConn) : item;
    const prevItem = prevById.get(item.connectionId);
    if (
      prevItem &&
      overlaid.status === "offline" &&
      !overlaid.engineVersion &&
      (prevItem.status !== "offline" || Boolean(prevItem.engineVersion))
    ) {
      return {
        ...overlaid,
        status: prevItem.status,
        engineVersion: prevItem.engineVersion,
        apiVersion: prevItem.apiVersion,
        warningMessage: prevItem.warningMessage ?? overlaid.warningMessage,
        containersRunning: prevItem.containersRunning,
        containersTotal: prevItem.containersTotal,
      };
    }
    return overlaid;
  });
  const extras = prev.filter(
    (item) => storedById.has(item.connectionId) && !probedIds.has(item.connectionId),
  );
  return extras.length > 0 ? [...merged, ...extras] : merged;
}

/** 单条探测结果写回侧栏状态。 */
export function applyDockerProbeResult(
  prev: readonly DockerConnectionInfo[],
  connectionId: string,
  probe: {
    status: DockerConnectionInfo["status"];
    engineVersion: string | null;
    apiVersion: string | null;
    warningMessage: string | null;
  },
): DockerConnectionInfo[] {
  markDockerProbed([connectionId]);
  let changed = false;
  const next = prev.map((item) => {
    if (item.connectionId !== connectionId) return item;
    changed = true;
    return {
      ...item,
      status: probe.status,
      engineVersion: probe.engineVersion ?? item.engineVersion,
      apiVersion: probe.apiVersion ?? item.apiVersion,
      warningMessage: probe.warningMessage ?? item.warningMessage,
    };
  });
  return changed ? next : (prev as DockerConnectionInfo[]);
}

/** 侧栏状态点：未探测=灰，探测中=橙，在线=绿，降级=橙，探测后离线=红。 */
export function dockerSidebarStatusDot(
  connectionId: string,
  status: DockerConnectionInfo["status"],
): SidebarStatusLike {
  if (isDockerConnectionProbePending(connectionId)) return "connecting";
  if (status === "online") return "online";
  if (status === "degraded") return "connecting";
  if (!isDockerConnectionProbed(connectionId)) return "idle";
  return "offline";
}

type SidebarStatusLike = "online" | "connecting" | "offline" | "idle";
