/**
 * Docker 侧栏树形分组布局（嵌套文件夹 + 实例归属）。
 * 与 Connection.group 解耦，仅影响侧栏展示顺序与层级。
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createIndexedDBStorage } from "@/lib/indexedDbStorage";

export type DockerSidebarFolder = {
  id: string;
  name: string;
  /** 父文件夹 id；null 表示根级 */
  parentId: string | null;
};

type DockerSidebarTreeState = {
  folders: DockerSidebarFolder[];
  /** connectionId → folderId；未出现则挂在根级 */
  connectionFolderId: Record<string, string>;
  /** 根级与各文件夹内子节点顺序（folderId 或 connectionId，前缀 f: / c:） */
  orderByParent: Record<string, string[]>;
  createFolder: (name: string, parentId?: string | null) => string;
  renameFolder: (folderId: string, name: string) => void;
  deleteFolder: (folderId: string) => void;
  moveNode: (opts: {
    nodeKey: string;
    targetParentId: string | null;
    beforeKey?: string | null;
  }) => void;
  ensureConnectionListed: (connectionId: string) => void;
  pruneMissingConnections: (activeConnectionIds: string[]) => void;
};

const ROOT_KEY = "__root__";
const STORAGE_KEY = "omnipanel.dockerSidebarTree.v1";

function folderKey(id: string): string {
  return `f:${id}`;
}

function connectionKey(id: string): string {
  return `c:${id}`;
}

export function parseDockerSidebarNodeKey(
  key: string,
): { kind: "folder" | "connection"; id: string } | null {
  if (key.startsWith("f:")) return { kind: "folder", id: key.slice(2) };
  if (key.startsWith("c:")) return { kind: "connection", id: key.slice(2) };
  return null;
}

export function dockerSidebarFolderNodeKey(id: string): string {
  return folderKey(id);
}

export function dockerSidebarConnectionNodeKey(id: string): string {
  return connectionKey(id);
}

function parentStorageKey(parentId: string | null): string {
  return parentId ?? ROOT_KEY;
}

function isDescendantFolder(
  folders: DockerSidebarFolder[],
  folderId: string,
  maybeAncestorId: string,
): boolean {
  let cur: string | null = folderId;
  const byId = new Map(folders.map((f) => [f.id, f]));
  while (cur) {
    if (cur === maybeAncestorId) return true;
    cur = byId.get(cur)?.parentId ?? null;
  }
  return false;
}

function genFolderId(): string {
  return `dfolder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useDockerSidebarTreeStore = create<DockerSidebarTreeState>()(
  persist(
    (set) => ({
      folders: [],
      connectionFolderId: {},
      orderByParent: { [ROOT_KEY]: [] },

      createFolder: (name, parentId = null) => {
        const id = genFolderId();
        const trimmed = name.trim() || "新建分组";
        set((state) => {
          const parentKey = parentStorageKey(parentId);
          const order = [...(state.orderByParent[parentKey] ?? [])];
          const key = folderKey(id);
          if (!order.includes(key)) order.push(key);
          return {
            folders: [...state.folders, { id, name: trimmed, parentId }],
            orderByParent: {
              ...state.orderByParent,
              [parentKey]: order,
              [id]: state.orderByParent[id] ?? [],
            },
          };
        });
        return id;
      },

      renameFolder: (folderId, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        set((state) => ({
          folders: state.folders.map((f) =>
            f.id === folderId ? { ...f, name: trimmed } : f,
          ),
        }));
      },

      deleteFolder: (folderId) => {
        set((state) => {
          const folder = state.folders.find((f) => f.id === folderId);
          if (!folder) return state;
          const parentKey = parentStorageKey(folder.parentId);
          const childOrder = [...(state.orderByParent[folderId] ?? [])];
          const parentOrder = [...(state.orderByParent[parentKey] ?? [])].filter(
            (k) => k !== folderKey(folderId),
          );
          // 子节点升到父级
          for (const child of childOrder) {
            if (!parentOrder.includes(child)) parentOrder.push(child);
          }

          const connectionFolderId = { ...state.connectionFolderId };
          for (const [connId, fid] of Object.entries(connectionFolderId)) {
            if (fid === folderId) {
              if (folder.parentId) connectionFolderId[connId] = folder.parentId;
              else delete connectionFolderId[connId];
            }
          }

          const folders = state.folders
            .filter((f) => f.id !== folderId)
            .map((f) =>
              f.parentId === folderId ? { ...f, parentId: folder.parentId } : f,
            );

          const orderByParent = { ...state.orderByParent };
          delete orderByParent[folderId];
          orderByParent[parentKey] = parentOrder;

          return { folders, connectionFolderId, orderByParent };
        });
      },

      moveNode: ({ nodeKey, targetParentId, beforeKey = null }) => {
        const parsed = parseDockerSidebarNodeKey(nodeKey);
        if (!parsed) return;

        set((state) => {
          // 禁止把文件夹拖进自身或子孙
          if (
            parsed.kind === "folder" &&
            targetParentId &&
            (parsed.id === targetParentId ||
              isDescendantFolder(state.folders, targetParentId, parsed.id))
          ) {
            return state;
          }

          const nextFolders = state.folders.map((f) =>
            parsed.kind === "folder" && f.id === parsed.id
              ? { ...f, parentId: targetParentId }
              : f,
          );
          const connectionFolderId = { ...state.connectionFolderId };
          if (parsed.kind === "connection") {
            if (targetParentId) connectionFolderId[parsed.id] = targetParentId;
            else delete connectionFolderId[parsed.id];
          }

          const orderByParent: Record<string, string[]> = {};
          for (const [k, v] of Object.entries(state.orderByParent)) {
            orderByParent[k] = v.filter((item) => item !== nodeKey);
          }

          const destKey = parentStorageKey(targetParentId);
          const dest = [...(orderByParent[destKey] ?? [])];
          const insertAt =
            beforeKey && dest.includes(beforeKey) ? dest.indexOf(beforeKey) : dest.length;
          dest.splice(insertAt, 0, nodeKey);
          orderByParent[destKey] = dest;

          return {
            folders: nextFolders,
            connectionFolderId,
            orderByParent,
          };
        });
      },

      ensureConnectionListed: (connectionId) => {
        const key = connectionKey(connectionId);
        set((state) => {
          const folderId = state.connectionFolderId[connectionId] ?? null;
          const parentKey = parentStorageKey(folderId);
          const order = [...(state.orderByParent[parentKey] ?? [])];
          if (order.includes(key)) return state;
          // 也可能误挂在别的 order 里，先清掉
          const orderByParent: Record<string, string[]> = {};
          for (const [k, v] of Object.entries(state.orderByParent)) {
            orderByParent[k] = v.filter((item) => item !== key);
          }
          const dest = [...(orderByParent[parentKey] ?? [])];
          dest.push(key);
          orderByParent[parentKey] = dest;
          return { orderByParent };
        });
      },

      pruneMissingConnections: (activeConnectionIds) => {
        const active = new Set(activeConnectionIds);
        set((state) => {
          const connectionFolderId: Record<string, string> = {};
          for (const [id, folderId] of Object.entries(state.connectionFolderId)) {
            if (active.has(id)) connectionFolderId[id] = folderId;
          }
          const orderByParent: Record<string, string[]> = {};
          for (const [k, v] of Object.entries(state.orderByParent)) {
            orderByParent[k] = v.filter((item) => {
              const parsed = parseDockerSidebarNodeKey(item);
              if (!parsed) return false;
              if (parsed.kind === "folder") return true;
              return active.has(parsed.id);
            });
          }
          // 补上尚未登记的连接
          for (const id of activeConnectionIds) {
            const key = connectionKey(id);
            const folderId = connectionFolderId[id] ?? null;
            const parentKey = parentStorageKey(folderId);
            const order = orderByParent[parentKey] ?? (orderByParent[parentKey] = []);
            if (!order.includes(key)) order.push(key);
          }
          return { connectionFolderId, orderByParent };
        });
      },
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(createIndexedDBStorage),
      partialize: (state) => ({
        folders: state.folders,
        connectionFolderId: state.connectionFolderId,
        orderByParent: state.orderByParent,
      }),
    },
  ),
);

export type DockerSidebarTreeItem =
  | { kind: "folder"; folder: DockerSidebarFolder }
  | { kind: "connection"; connectionId: string };

/** 列出某父级下的有序子节点（仅一层）。 */
export function listDockerSidebarChildren(
  state: Pick<DockerSidebarTreeState, "folders" | "orderByParent" | "connectionFolderId">,
  parentId: string | null,
  connectionIds: string[],
): DockerSidebarTreeItem[] {
  const parentKey = parentStorageKey(parentId);
  const active = new Set(connectionIds);
  const folderById = new Map(state.folders.map((f) => [f.id, f]));
  const ordered = state.orderByParent[parentKey] ?? [];
  const items: DockerSidebarTreeItem[] = [];
  const seen = new Set<string>();

  for (const key of ordered) {
    const parsed = parseDockerSidebarNodeKey(key);
    if (!parsed || seen.has(key)) continue;
    if (parsed.kind === "folder") {
      const folder = folderById.get(parsed.id);
      if (!folder || folder.parentId !== parentId) continue;
      seen.add(key);
      items.push({ kind: "folder", folder });
    } else if (active.has(parsed.id)) {
      const assigned = state.connectionFolderId[parsed.id] ?? null;
      if (assigned !== parentId) continue;
      seen.add(key);
      items.push({ kind: "connection", connectionId: parsed.id });
    }
  }

  // 补漏：该父级下未进 order 的文件夹 / 连接
  for (const folder of state.folders) {
    if (folder.parentId !== parentId) continue;
    const key = folderKey(folder.id);
    if (seen.has(key)) continue;
    items.push({ kind: "folder", folder });
  }
  for (const id of connectionIds) {
    const assigned = state.connectionFolderId[id] ?? null;
    if (assigned !== parentId) continue;
    const key = connectionKey(id);
    if (seen.has(key)) continue;
    items.push({ kind: "connection", connectionId: id });
  }

  return items;
}

/**
 * 深度优先收集侧栏可选节点 treeKey（含折叠子树），
 * 供 Ctrl+A 全选 / Shift 范围多选。连接 key 用 `docker:${id}`，文件夹用 `docker-folder:${id}`。
 */
export function collectAllDockerSidebarTreeKeys(
  state: Pick<DockerSidebarTreeState, "folders" | "orderByParent" | "connectionFolderId">,
  connectionIds: string[],
  connectionTreeKey: (connectionId: string) => string,
  parentId: string | null = null,
): string[] {
  const children = listDockerSidebarChildren(state, parentId, connectionIds);
  const keys: string[] = [];
  for (const item of children) {
    if (item.kind === "folder") {
      keys.push(`docker-folder:${item.folder.id}`);
      keys.push(
        ...collectAllDockerSidebarTreeKeys(
          state,
          connectionIds,
          connectionTreeKey,
          item.folder.id,
        ),
      );
    } else {
      keys.push(connectionTreeKey(item.connectionId));
    }
  }
  return keys;
}

export function parseDockerSidebarFolderTreeKey(key: string): string | null {
  return key.startsWith("docker-folder:") ? key.slice("docker-folder:".length) : null;
}
