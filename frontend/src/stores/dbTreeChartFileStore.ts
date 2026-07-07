import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { commands } from "../ipc/bindings";
import {
  createEmptyTreeChartDocument,
  serializeTreeChartDocument,
} from "../modules/database/treeChart/treeChartDocument";

export interface DbTreeChartFileNode {
  id: string;
  name: string;
  document: string;
  updatedAt: number;
}

interface DbTreeChartFileState {
  nodes: DbTreeChartFileNode[];
  dirtyFileIds: string[];
  isFileDirty: (id: string) => boolean;
  flushToDisk: () => Promise<void>;
  addFile: (name: string, document?: string) => DbTreeChartFileNode;
  updateFileDocument: (id: string, document: string) => void;
  renameNode: (id: string, name: string) => boolean;
  deleteNode: (id: string) => void;
  getNode: (id: string) => DbTreeChartFileNode | undefined;
  replaceNodes: (nodes: DbTreeChartFileNode[]) => void;
}

const CACHE_KEY = "omnipanel-db-tree-chart-files";

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

function serializeNodeForDisk(node: DbTreeChartFileNode) {
  return {
    id: node.id,
    name: node.name,
    document: node.document,
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
  get: () => DbTreeChartFileState,
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
        await persistNodes(get().nodes);
        set({ dirtyFileIds: [] });
      },

      replaceNodes: (nodes) => {
        commitNodesInMemory(set, get, nodes, nodes.map((node) => node.id));
      },

      addFile: (name, document = serializeTreeChartDocument(createEmptyTreeChartDocument())) => {
        const fileName = uniqueName(
          get().nodes,
          name.endsWith(".ctr") ? name : `${name}.ctr`,
        );
        const node: DbTreeChartFileNode = {
          id: makeId(),
          name: fileName,
          document,
          updatedAt: Date.now(),
        };
        const nodes = [...get().nodes, node];
        commitNodesInMemory(set, get, nodes, [node.id]);
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
        commitNodesInMemory(set, get, nodes, [id]);
        return true;
      },

      deleteNode: (id) => {
        const nodes = get().nodes.filter((node) => node.id !== id);
        commitNodesInMemory(set, get, nodes, [id]);
      },

      getNode: (id) => get().nodes.find((node) => node.id === id),
    }),
    {
      name: CACHE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ nodes: state.nodes }),
      migrate: (persisted) => persisted as { nodes: DbTreeChartFileNode[] },
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
      const cached = readNodesCache();
      if (cached?.length) {
        useDbTreeChartFileStore.setState({ nodes: cached, dirtyFileIds: [] });
      }
      return;
    }

    try {
      const res = await commands.dbTreeChartFilesLoad();
      if (res.status !== "ok") {
        console.warn("[dbTreeChartFileStore] 加载失败:", res.error);
        const cached = readNodesCache();
        if (cached?.length) {
          useDbTreeChartFileStore.setState({ nodes: cached });
        }
        return;
      }

      const diskNodes = normalizeNodes(res.data.nodes);
      if (diskNodes.length === 0) {
        const cached = readNodesCache();
        if (cached?.length) {
          useDbTreeChartFileStore.setState({ nodes: cached, dirtyFileIds: [] });
          await persistNodes(cached);
        }
        return;
      }

      useDbTreeChartFileStore.setState({ nodes: diskNodes, dirtyFileIds: [] });
      writeNodesCache(diskNodes);
    } catch (error) {
      console.warn("[dbTreeChartFileStore] 初始化加载失败:", error);
      const cached = readNodesCache();
      if (cached?.length) {
        useDbTreeChartFileStore.setState({ nodes: cached, dirtyFileIds: [] });
      }
    }
  })();

  await initPromise;
}

export function formatTreeChartFileLabel(name: string): string {
  return name.replace(/\.ctr$/i, "");
}
