import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { commands } from "../ipc/bindings";
import { useDbSqlFileStore } from "./dbSqlFileStore";
import {
  createEmptyTreeChartDocument,
  serializeTreeChartDocument,
} from "../modules/database/treeChart/treeChartDocument";

export interface DbTreeChartFileNode {
  id: string;
  name: string;
  document: string;
  parentId: string | null;
  updatedAt: number;
}

/** 树结构变更（新建/重命名/删除/移动）的落盘脏标记 */
export const TREE_CHART_FILE_TREE_DIRTY = "__tree__";

interface DbTreeChartFileState {
  nodes: DbTreeChartFileNode[];
  /** 尚未写入磁盘的文件 id；含 {@link TREE_CHART_FILE_TREE_DIRTY} 表示树结构有变 */
  dirtyFileIds: string[];
  isFileDirty: (id: string) => boolean;
  /** 将内存中的节点与缓存写入磁盘，并清除脏标记 */
  flushToDisk: () => Promise<void>;
  addFile: (name: string, document?: string, parentId?: string | null) => DbTreeChartFileNode;
  updateFileDocument: (id: string, document: string) => void;
  renameNode: (id: string, name: string) => boolean;
  moveNode: (id: string, newParentId: string | null) => boolean;
  canMoveNodeToParent: (id: string, newParentId: string | null) => boolean;
  detachFromFolder: (folderId: string) => void;
  deleteNode: (id: string) => void;
  getNode: (id: string) => DbTreeChartFileNode | undefined;
  replaceNodes: (nodes: DbTreeChartFileNode[]) => void;
}

const CACHE_KEY = "omnipanel-db-tree-chart-files";
const LEGACY_PERSIST_KEY = "omnipanel-db-tree-chart-files";

let initPromise: Promise<void> | null = null;

function makeId(): string {
  return `ctr-file:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function uniqueName(nodes: DbTreeChartFileNode[], name: string, excludeId?: string): string {
  const base = name.trim() || "untitled";
  const siblings = nodes.filter((node) => node.id !== excludeId);
  if (!siblings.some((node) => node.name === base)) {
    return base;
  }
  let index = 2;
  while (siblings.some((node) => node.name === `${base.replace(/\.ctr$/i, "")} ${index}.ctr`)) {
    index += 1;
  }
  const stem = base.replace(/\.ctr$/i, "");
  return `${stem} ${index}.ctr`;
}

function isSqlFolderId(folderId: string): boolean {
  const node = useDbSqlFileStore.getState().getNode(folderId);
  return Boolean(node && node.type === "folder");
}

function normalizeNode(raw: Record<string, unknown>): DbTreeChartFileNode | null {
  const id = typeof raw.id === "string" ? raw.id : "";
  const name = typeof raw.name === "string" ? raw.name : "";
  if (!id || !name) {
    return null;
  }
  return {
    id,
    name: name.endsWith(".ctr") ? name : `${name}.ctr`,
    document:
      typeof raw.document === "string"
        ? raw.document
        : serializeTreeChartDocument(createEmptyTreeChartDocument()),
    parentId:
      typeof raw.parentId === "string"
        ? raw.parentId
        : raw.parentId === null
          ? null
          : null,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : Date.now(),
  };
}

function normalizeNodes(list: unknown): DbTreeChartFileNode[] {
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((item) => (item && typeof item === "object" ? normalizeNode(item as Record<string, unknown>) : null))
    .filter((node): node is DbTreeChartFileNode => node !== null);
}

function writeNodesCache(nodes: DbTreeChartFileNode[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ version: 1, nodes }));
  } catch (error) {
    console.warn("[dbTreeChartFileStore] 写入 localStorage 缓存失败:", error);
  }
}

function readNodesCache(): DbTreeChartFileNode[] | null {
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

function readLegacyPersistedNodes(): DbTreeChartFileNode[] | null {
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

function serializeNodeForDisk(node: DbTreeChartFileNode) {
  return {
    id: node.id,
    name: node.name,
    document: node.document,
    parentId: node.parentId,
    updatedAt: node.updatedAt,
  };
}

async function persistNodes(nodes: DbTreeChartFileNode[]): Promise<void> {
  writeNodesCache(nodes);
  if (!isTauriRuntime()) {
    return;
  }
  try {
    const res = await commands.dbTreeChartFilesSave({
      version: 1,
      nodes: nodes.map(serializeNodeForDisk),
    });
    if (res.status === "error") {
      console.warn("[dbTreeChartFileStore] 写入磁盘失败:", res.error);
    }
  } catch (error) {
    console.warn("[dbTreeChartFileStore] 写入磁盘失败:", error);
  }
}

function markDirtyIds(prev: string[], ids: string[]): string[] {
  const next = new Set(prev);
  for (const id of ids) {
    next.add(id);
  }
  return [...next];
}

function commitNodesInMemory(
  set: (fn: (state: DbTreeChartFileState) => Partial<DbTreeChartFileState>) => void,
  _get: () => DbTreeChartFileState,
  nodes: DbTreeChartFileNode[],
  dirtyIds: string[] = [],
) {
  set((state) => ({
    nodes,
    dirtyFileIds: markDirtyIds(state.dirtyFileIds, dirtyIds),
  }));
}

export const useDbTreeChartFileStore = create<DbTreeChartFileState>()(
  persist(
    (set, get) => ({
      nodes: [],
      dirtyFileIds: [],

      isFileDirty: (id) => get().dirtyFileIds.includes(id),

      flushToDisk: async () => {
        if (get().dirtyFileIds.length === 0) {
          return;
        }
        const nodes = get().nodes;
        if (nodes.length === 0) {
          if (!isTauriRuntime()) {
            set({ dirtyFileIds: [] });
            return;
          }
          try {
            const res = await commands.dbTreeChartFilesLoad();
            const diskNodes =
              res.status === "ok" ? normalizeNodes(res.data.nodes) : [];
            if (diskNodes.length > 0) {
              console.warn(
                "[dbTreeChartFileStore] 跳过空列表落盘，避免覆盖已有 .ctr 文件",
              );
              set({ dirtyFileIds: [] });
              return;
            }
          } catch {
            // 加载失败时仍允许写入空列表
          }
        }
        await persistNodes(nodes);
        set({ dirtyFileIds: [] });
      },

      replaceNodes: (nodes) => {
        commitNodesInMemory(
          set,
          get,
          nodes,
          nodes.map((node) => node.id),
        );
      },

      addFile: (name, document = serializeTreeChartDocument(createEmptyTreeChartDocument()), parentId = null) => {
        const fileName = uniqueName(
          get().nodes,
          name.endsWith(".ctr") ? name : `${name}.ctr`,
        );
        const node: DbTreeChartFileNode = {
          id: makeId(),
          name: fileName,
          document,
          parentId,
          updatedAt: Date.now(),
        };
        const nodes = [...get().nodes, node];
        commitNodesInMemory(set, get, nodes, [node.id, TREE_CHART_FILE_TREE_DIRTY]);
        return node;
      },

      updateFileDocument: (id, document) => {
        const nodes = get().nodes.map((node) =>
          node.id === id ? { ...node, document, updatedAt: Date.now() } : node,
        );
        commitNodesInMemory(set, get, nodes, [id]);
      },

      renameNode: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) {
          return false;
        }
        const nextName = trimmed.endsWith(".ctr") ? trimmed : `${trimmed}.ctr`;
        const nodes = get().nodes.map((node) =>
          node.id === id
            ? {
                ...node,
                name: uniqueName(get().nodes, nextName, node.id),
                updatedAt: Date.now(),
              }
            : node,
        );
        commitNodesInMemory(set, get, nodes, [id, TREE_CHART_FILE_TREE_DIRTY]);
        return true;
      },

      canMoveNodeToParent: (id, newParentId) => {
        const node = get().nodes.find((entry) => entry.id === id);
        if (!node) {
          return false;
        }
        if ((node.parentId ?? null) === newParentId) {
          return false;
        }
        if (newParentId && !isSqlFolderId(newParentId)) {
          return false;
        }
        return true;
      },

      moveNode: (id, newParentId) => {
        if (!get().canMoveNodeToParent(id, newParentId)) {
          return false;
        }
        const node = get().nodes.find((entry) => entry.id === id);
        if (!node) {
          return false;
        }
        const nodes = get().nodes.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                parentId: newParentId,
                updatedAt: Date.now(),
              }
            : entry,
        );
        commitNodesInMemory(set, get, nodes, [id, TREE_CHART_FILE_TREE_DIRTY]);
        return true;
      },

      detachFromFolder: (folderId) => {
        const movedIds: string[] = [];
        const nodes = get().nodes.map((entry) => {
          if (entry.parentId !== folderId) {
            return entry;
          }
          movedIds.push(entry.id);
          return {
            ...entry,
            parentId: null,
            updatedAt: Date.now(),
          };
        });
        if (movedIds.length === 0) {
          return;
        }
        commitNodesInMemory(set, get, nodes, [...movedIds, TREE_CHART_FILE_TREE_DIRTY]);
      },

      deleteNode: (id) => {
        const nodes = get().nodes.filter((node) => node.id !== id);
        commitNodesInMemory(set, get, nodes, [id, TREE_CHART_FILE_TREE_DIRTY]);
      },

      getNode: (id) => get().nodes.find((node) => node.id === id),
    }),
    {
      name: CACHE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ nodes: state.nodes }),
      migrate: (persisted) => {
        if (!persisted || typeof persisted !== "object") {
          return { nodes: [] as DbTreeChartFileNode[] };
        }
        const record = persisted as {
          state?: { nodes?: unknown };
          nodes?: unknown;
        };
        return {
          nodes: normalizeNodes(record.state?.nodes ?? record.nodes),
        };
      },
    },
  ),
);

export async function initDbTreeChartFilesStore(force = false): Promise<void> {
  if (!force && useDbTreeChartFileStore.getState().nodes.length > 0) {
    return;
  }
  if (initPromise && !force) {
    return initPromise;
  }

  initPromise = (async () => {
    if (!isTauriRuntime()) {
      const cached = readNodesCache() ?? readLegacyPersistedNodes();
      if (cached?.length) {
        useDbTreeChartFileStore.setState({ nodes: cached, dirtyFileIds: [] });
      }
      return;
    }

    try {
      const res = await commands.dbTreeChartFilesLoad();
      if (res.status !== "ok") {
        console.warn("[dbTreeChartFileStore] 加载失败:", res.error);
        const cached = readNodesCache() ?? readLegacyPersistedNodes();
        if (cached?.length) {
          useDbTreeChartFileStore.setState({ nodes: cached });
        }
        return;
      }

      const diskNodes = normalizeNodes(res.data.nodes);
      if (diskNodes.length === 0) {
        const legacy = readLegacyPersistedNodes() ?? readNodesCache();
        if (legacy?.length) {
          useDbTreeChartFileStore.setState({ nodes: legacy, dirtyFileIds: [] });
          await persistNodes(legacy);
          console.info(
            `[dbTreeChartFileStore] 已从 localStorage 迁移 ${legacy.length} 个 .ctr 文件到磁盘`,
          );
        }
        return;
      }

      useDbTreeChartFileStore.setState({ nodes: diskNodes, dirtyFileIds: [] });
      writeNodesCache(diskNodes);
    } catch (error) {
      console.warn("[dbTreeChartFileStore] 初始化加载失败:", error);
      const cached = readNodesCache() ?? readLegacyPersistedNodes();
      if (cached?.length) {
        useDbTreeChartFileStore.setState({ nodes: cached, dirtyFileIds: [] });
      }
    }
  })();

  await initPromise;
}

/** 手动尝试从 localStorage 恢复 .ctr 文件并写回磁盘 */
export async function recoverTreeChartFilesFromLocalStorage(): Promise<number> {
  const cached = readLegacyPersistedNodes() ?? readNodesCache();
  if (!cached?.length) {
    return 0;
  }

  let mergedById = new Map<string, DbTreeChartFileNode>();
  if (isTauriRuntime()) {
    try {
      const res = await commands.dbTreeChartFilesLoad();
      if (res.status === "ok") {
        diskCount = normalizeNodes(res.data.nodes).length;
        for (const node of normalizeNodes(res.data.nodes)) {
          mergedById.set(node.id, node);
        }
      }
    } catch {
      // ignore
    }
  }
  for (const node of cached) {
    const existing = mergedById.get(node.id);
    if (!existing || node.updatedAt >= existing.updatedAt) {
      mergedById.set(node.id, node);
    }
  }
  const merged = [...mergedById.values()];
  useDbTreeChartFileStore.setState({
    nodes: merged,
    dirtyFileIds: merged.map((node) => node.id),
  });
  await useDbTreeChartFileStore.getState().flushToDisk();
  return merged.length - diskCount;
}

export function formatTreeChartFileLabel(name: string): string {
  return name.replace(/\.ctr$/i, "");
}
