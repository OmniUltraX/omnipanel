import { useMemo } from "react";
import { create } from "zustand";
import {
  commands,
  type Connection,
  type ConnectionKind,
  type SshConfigSyncResult,
} from "../ipc/bindings";
import {
  SEED_RESOURCES,
  type EnvironmentTag,
  type ResourceType,
  type WorkspaceResource,
} from "../lib/resourceRegistry";
import { normalizeSshGroup, sanitizeSshGroupInput } from "../lib/sshGroups";

/**
 * 连接状态层：后端 `omnipanel-store` 持久化的统一连接模型在前端的唯一缓存。
 * 真实数据来自 `conn_*` 命令；后端无数据时回退到 `SEED_RESOURCES` 作为空态占位。
 */
interface ConnectionState {
  connections: Connection[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  save: (connection: Connection) => Promise<Connection | null>;
  /** 批量更新 SSH 连接分组（单次状态提交，避免列表重复 key 抖动） */
  moveSshConnectionsToGroup: (connectionIds: string[], group: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  test: (connection: Connection) => Promise<{ ok: boolean; message: string }>;
}

const KIND_TO_TYPE: Record<ConnectionKind, ResourceType> = {
  ssh: "ssh",
  database: "database",
  docker: "docker",
  protocol: "protocol",
  panel: "server",
};

const VALID_ENV_TAGS: EnvironmentTag[] = ["prod", "staging", "dev", "local", "unknown"];

function normalizeEnv(tag: string | undefined): EnvironmentTag {
  return VALID_ENV_TAGS.includes(tag as EnvironmentTag) ? (tag as EnvironmentTag) : "unknown";
}

/** 从连接的 config JSON 文本中提取人类可读副标题（host:port / database 等）。 */
function deriveSubtitle(connection: Connection): string {
  try {
    const cfg = connection.config ? (JSON.parse(connection.config) as Record<string, unknown>) : {};
    const host = typeof cfg.host === "string" ? cfg.host : undefined;
    const port = typeof cfg.port === "number" ? cfg.port : undefined;
    const user = typeof cfg.user === "string" ? cfg.user : undefined;
    const database = typeof cfg.database === "string" ? cfg.database : undefined;
    if (host && user) return `${user}@${host}${port ? `:${port}` : ""}`;
    if (host) return `${host}${port ? `:${port}` : ""}`;
    if (database) return database;
  } catch {
    // config 非合法 JSON 时忽略，回退到 group
  }
  return connection.group || "";
}

/** 将后端 Connection 映射为前端展示用的 WorkspaceResource。 */
export function connectionToResource(connection: Connection): WorkspaceResource {
  const type = KIND_TO_TYPE[connection.kind] ?? "server";
  return {
    id: connection.id,
    type,
    name: connection.name,
    subtitle: deriveSubtitle(connection),
    modulePath: `/${type}`,
    environment: normalizeEnv(connection.envTag),
    status: "idle",
    group: normalizeSshGroup(connection.group),
  };
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connections: [],
  loaded: false,
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const res = await commands.connList();
      if (res.status === "ok") {
        set({ connections: res.data, loaded: true, loading: false });
      } else {
        set({ error: res.error.message, loaded: true, loading: false });
      }
    } catch (e) {
      // 非 Tauri 环境（纯 vite 预览）或 IPC 不可用：优雅降级到空态。
      set({ error: String(e), loaded: true, loading: false });
    }
  },

  save: async (connection) => {
    try {
      const res = await commands.connSave(connection);
      if (res.status === "ok") {
        const saved = res.data;
        set((state) => {
          const idx = state.connections.findIndex((c) => c.id === saved.id);
          const next =
            idx >= 0
              ? state.connections.map((c) => (c.id === saved.id ? saved : c))
              : [saved, ...state.connections];
          return { connections: next };
        });
        return saved;
      }
      set({ error: res.error.message });
      return null;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  moveSshConnectionsToGroup: async (connectionIds, group) => {
    const targetGroup = sanitizeSshGroupInput(group);
    const idSet = new Set(connectionIds);
    const toMove = get().connections.filter((c) => c.kind === "ssh" && idSet.has(c.id));
    if (toMove.length === 0) return;

    const saved: Connection[] = [];
    try {
      for (const conn of toMove) {
        const res = await commands.connSave({ ...conn, group: targetGroup });
        if (res.status === "ok") {
          saved.push(res.data);
        } else {
          set({ error: res.error.message });
          return;
        }
      }
      const savedMap = new Map(saved.map((c) => [c.id, c]));
      set((state) => ({
        connections: state.connections.map((c) => savedMap.get(c.id) ?? c),
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  remove: async (id) => {
    try {
      const res = await commands.connDelete(id);
      if (res.status === "ok") {
        set((state) => ({ connections: state.connections.filter((c) => c.id !== id) }));
      } else {
        set({ error: res.error.message });
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },

  test: async (connection) => {
    try {
      const res = await commands.connTest(connection);
      if (res.status === "ok") {
        return { ok: true, message: res.data };
      }
      return { ok: false, message: res.error.message };
    } catch (e) {
      return { ok: false, message: String(e) };
    }
  },
}));

/**
 * 订阅式选择器：返回当前连接映射的资源列表。
 * 后端无连接时回退 `SEED_RESOURCES`，保证首启与空态界面不空白。
 */
export function useWorkspaceResources(): WorkspaceResource[] {
  return useConnectionStore((state) =>
    state.connections.length > 0
      ? state.connections.map(connectionToResource)
      : SEED_RESOURCES,
  );
}

/** 应用启动时拉取一次后端连接。 */
export function initConnections() {
  void useConnectionStore.getState().refresh();
}

/** 将 `~/.ssh/config` 同步到本地持久化存储，并刷新连接列表。 */
export async function syncFromOpenSshConfig(): Promise<SshConfigSyncResult | null> {
  try {
    const res = await commands.sshSyncConfigHosts();
    if (res.status === "ok") {
      await useConnectionStore.getState().refresh();
      return res.data;
    }
    useConnectionStore.setState({ error: res.error.message });
    return null;
  } catch (e) {
    useConnectionStore.setState({ error: String(e) });
    return null;
  }
}

/** SSH 模块主机列表：仅展示持久化存储中的 SSH 连接。 */
export function useSshHostResources(): WorkspaceResource[] {
  const connections = useConnectionStore((state) => state.connections);
  const loaded = useConnectionStore((state) => state.loaded);

  return useMemo(() => {
    const stored = connections
      .filter((c) => c.kind === "ssh")
      .map(connectionToResource);
    if (stored.length > 0) return stored;
    if (loaded) return SEED_RESOURCES.filter((r) => r.type === "ssh");
    return [];
  }, [connections, loaded]);
}
