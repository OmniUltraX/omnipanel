import { create } from "zustand";
import { commands, type Connection, type ConnectionKind } from "../ipc/bindings";
import {
  SEED_RESOURCES,
  type EnvironmentTag,
  type ResourceType,
  type WorkspaceResource,
} from "../lib/resourceRegistry";

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
  };
}

export const useConnectionStore = create<ConnectionState>((set) => ({
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
