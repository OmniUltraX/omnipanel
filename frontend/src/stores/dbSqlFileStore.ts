import { create } from "zustand";

import { commands } from "../ipc/bindings";
import type { SqlTabState } from "../modules/database/dbWorkspaceState";

export type DbSqlFileNodeType = "folder" | "file";

export interface DbSqlFileNode {
  id: string;
  type: DbSqlFileNodeType;
  name: string;
  parentId: string | null;
  sql?: string;
  /** 上次在此文件上选用的数据库连接 */
  connId?: string;
  /** 上次在此文件上选用的数据库名 */
  database?: string;
  updatedAt: number;
}

interface DbSqlFileState {
  nodes: DbSqlFileNode[];
  addFolder: (parentId: string | null, name: string) => DbSqlFileNode;
  addFile: (parentId: string | null, name: string, sql?: string) => DbSqlFileNode;
  updateFileSql: (id: string, sql: string) => void;
  updateFileBinding: (id: string, connId: string, database: string) => void;
  renameNode: (id: string, name: string) => boolean;
  deleteNode: (id: string) => void;
  getNode: (id: string) => DbSqlFileNode | undefined;
  replaceNodes: (nodes: DbSqlFileNode[]) => void;
}

const CACHE_KEY = "omnipanel-db-sql-files";
const LEGACY_PERSIST_KEY = "omnipanel-db-sql-files";

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let initPromise: Promise<void> | null = null;

function makeId(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function uniqueName(
  nodes: DbSqlFileNode[],
  parentId: string | null,
  name: string,
  excludeId?: string,
): string {
  const base = name.trim() || "untitled";
  const siblings = nodes.filter((node) => node.parentId === parentId && node.id !== excludeId);
  if (!siblings.some((node) => node.name === base)) {
    return base;
  }
  let index = 2;
  while (siblings.some((node) => node.name === `${base} ${index}`)) {
    index += 1;
  }
  return `${base} ${index}`;
}

function collectDescendantIds(nodes: DbSqlFileNode[], rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id);
        changed = true;
      }
    }
  }
  return ids;
}

function normalizeNodeType(value: string | undefined): DbSqlFileNodeType {
  return value === "folder" ? "folder" : "file";
}

function normalizeNode(raw: Record<string, unknown>): DbSqlFileNode | null {
  const id = typeof raw.id === "string" ? raw.id : "";
  const name = typeof raw.name === "string" ? raw.name : "";
  if (!id || !name) {
    return null;
  }
  const nodeType = normalizeNodeType(
    typeof raw.type === "string"
      ? raw.type
      : typeof raw.nodeType === "string"
        ? raw.nodeType
        : undefined,
  );
  return {
    id,
    type: nodeType,
    name,
    parentId:
      typeof raw.parentId === "string"
        ? raw.parentId
        : raw.parentId === null
          ? null
          : null,
    sql: typeof raw.sql === "string" ? raw.sql : undefined,
    connId: typeof raw.connId === "string" ? raw.connId : undefined,
    database: typeof raw.database === "string" ? raw.database : undefined,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
  };
}

function normalizeNodes(list: unknown): DbSqlFileNode[] {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((item) => (item && typeof item === "object" ? normalizeNode(item as Record<string, unknown>) : null))
    .filter((node): node is DbSqlFileNode => node !== null);
}

function writeNodesCache(nodes: DbSqlFileNode[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ version: 1, nodes }));
  } catch (e) {
    console.warn("[dbSqlFileStore] 写入 localStorage 缓存失败:", e);
  }
}

function readNodesCache(): DbSqlFileNode[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { nodes?: unknown };
    const nodes = normalizeNodes(parsed.nodes);
    return nodes.length > 0 ? nodes : null;
  } catch {
    return null;
  }
}

function readLegacyPersistedNodes(): DbSqlFileNode[] | null {
  try {
    const raw = localStorage.getItem(LEGACY_PERSIST_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { state?: { nodes?: unknown }; nodes?: unknown };
    const nodes = normalizeNodes(parsed.state?.nodes ?? parsed.nodes);
    return nodes.length > 0 ? nodes : null;
  } catch {
    return null;
  }
}

function serializeNodeForDisk(node: DbSqlFileNode) {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    parentId: node.parentId,
    sql: node.sql ?? null,
    connId: node.connId ?? null,
    database: node.database ?? null,
    updatedAt: node.updatedAt,
  };
}

async function persistNodes(nodes: DbSqlFileNode[]): Promise<void> {
  writeNodesCache(nodes);
  if (!isTauriRuntime()) {
    return;
  }
  try {
    const res = await commands.dbSqlFilesSave({
      version: 1,
      nodes: nodes.map(serializeNodeForDisk),
    });
    if (res.status === "error") {
      console.warn("[dbSqlFileStore] 写入磁盘失败:", res.error);
    }
  } catch (e) {
    console.warn("[dbSqlFileStore] 写入磁盘失败:", e);
  }
}

function schedulePersist(nodes: DbSqlFileNode[]) {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistNodes(nodes);
  }, 400);
}

function commitNodes(set: (fn: (state: DbSqlFileState) => Partial<DbSqlFileState>) => void, nodes: DbSqlFileNode[]) {
  set(() => ({ nodes }));
  schedulePersist(nodes);
}

export function getSqlFileChildren(
  nodes: DbSqlFileNode[],
  parentId: string | null,
): DbSqlFileNode[] {
  return nodes
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "folder" ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
}

export const useDbSqlFileStore = create<DbSqlFileState>()((set, get) => ({
  nodes: [],

  replaceNodes: (nodes) => {
    commitNodes(set, nodes);
  },

  addFolder: (parentId, name) => {
    const node: DbSqlFileNode = {
      id: makeId("sql-folder"),
      type: "folder",
      name: uniqueName(get().nodes, parentId, name),
      parentId,
      updatedAt: Date.now(),
    };
    const nodes = [...get().nodes, node];
    commitNodes(set, nodes);
    return node;
  },

  addFile: (parentId, name, sql = "") => {
    const fileName = uniqueName(get().nodes, parentId, name.endsWith(".sql") ? name : `${name}.sql`);
    const node: DbSqlFileNode = {
      id: makeId("sql-file"),
      type: "file",
      name: fileName,
      parentId,
      sql,
      updatedAt: Date.now(),
    };
    const nodes = [...get().nodes, node];
    commitNodes(set, nodes);
    return node;
  },

  updateFileSql: (id, sql) => {
    const nodes = get().nodes.map((node) =>
      node.id === id && node.type === "file" ? { ...node, sql, updatedAt: Date.now() } : node,
    );
    commitNodes(set, nodes);
  },

  updateFileBinding: (id, connId, database) => {
    const nodes = get().nodes.map((node) =>
      node.id === id && node.type === "file"
        ? {
            ...node,
            connId: connId || undefined,
            database: database || undefined,
            updatedAt: Date.now(),
          }
        : node,
    );
    commitNodes(set, nodes);
  },

  renameNode: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) {
      return false;
    }
    const node = get().nodes.find((entry) => entry.id === id);
    if (!node) {
      return false;
    }
    const nextName =
      node.type === "file" && !trimmed.endsWith(".sql") ? `${trimmed}.sql` : trimmed;
    const nodes = get().nodes.map((entry) =>
      entry.id === id
        ? {
            ...entry,
            name: uniqueName(get().nodes, entry.parentId, nextName, entry.id),
            updatedAt: Date.now(),
          }
        : entry,
    );
    commitNodes(set, nodes);
    return true;
  },

  deleteNode: (id) => {
    const removeIds = collectDescendantIds(get().nodes, id);
    const nodes = get().nodes.filter((node) => !removeIds.has(node.id));
    commitNodes(set, nodes);
  },

  getNode: (id) => get().nodes.find((node) => node.id === id),
}));

export async function initDbSqlFilesStore(force = false): Promise<void> {
  if (!force && useDbSqlFileStore.getState().nodes.length > 0) {
    return;
  }
  if (initPromise && !force) {
    return initPromise;
  }

  initPromise = (async () => {
    if (!isTauriRuntime()) {
      const cached = readNodesCache() ?? readLegacyPersistedNodes();
      if (cached?.length) {
        useDbSqlFileStore.setState({ nodes: cached });
      }
      return;
    }

    try {
      const res = await commands.dbSqlFilesLoad();
      if (res.status !== "ok") {
        console.warn("[dbSqlFileStore] 加载失败:", res.error);
        const cached = readNodesCache() ?? readLegacyPersistedNodes();
        if (cached?.length) {
          useDbSqlFileStore.setState({ nodes: cached });
        }
        return;
      }

      const diskNodes = normalizeNodes(res.data.nodes);
      if (diskNodes.length === 0) {
        const legacy = readLegacyPersistedNodes() ?? readNodesCache();
        if (legacy?.length) {
          useDbSqlFileStore.setState({ nodes: legacy });
          await persistNodes(legacy);
          console.info(`[dbSqlFileStore] 已从 localStorage 迁移 ${legacy.length} 个 SQL 文件节点到磁盘`);
        }
        return;
      }

      useDbSqlFileStore.setState({ nodes: diskNodes });
      writeNodesCache(diskNodes);
    } catch (e) {
      console.warn("[dbSqlFileStore] 初始化加载失败:", e);
      const cached = readNodesCache() ?? readLegacyPersistedNodes();
      if (cached?.length) {
        useDbSqlFileStore.setState({ nodes: cached });
      }
    }
  })();

  await initPromise;
}

export async function persistDbSqlFilesStore(): Promise<void> {
  await persistNodes(useDbSqlFileStore.getState().nodes);
}

/** 从侧栏 SQL 文件恢复 Tab 编辑器状态（文件内容为权威来源）。 */
export function resolveSqlTabStateFromFile(sqlFileId: string, fallback: SqlTabState): SqlTabState {
  const file = useDbSqlFileStore.getState().getNode(sqlFileId);
  if (!file || file.type !== "file") {
    return fallback;
  }
  return {
    ...fallback,
    sql: file.sql ?? "",
    connId: file.connId ?? fallback.connId,
    database: file.database ?? fallback.database,
  };
}
