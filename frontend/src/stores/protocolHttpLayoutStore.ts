import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createSafeLocalStorage } from "../lib/zustandPersistStorage";
import { scheduleClientModuleSync } from "../modules/clientSync/moduleSync";

export type ProtocolHttpFolder = {
  id: string;
  name: string;
  parentId: string | null;
};

export type ProtocolTreeNodeKey =
  | `folder:${string}`
  | `collection:${string}`
  | `request:${string}`
  | `entry:${string}`;

export type ProtocolDropTarget =
  | { kind: "root" }
  | { kind: "folder"; folderId: string }
  | { kind: "collection"; collectionId: string };

function parentKey(target: ProtocolDropTarget): string {
  if (target.kind === "root") return "root";
  if (target.kind === "folder") return `folder:${target.folderId}`;
  return `collection:${target.collectionId}`;
}

function makeFolderId(): string {
  return `proto-folder:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function uniqueFolderName(
  folders: ProtocolHttpFolder[],
  parentId: string | null,
  name: string,
  excludeId?: string,
): string {
  const base = name.trim() || "Folder";
  const siblings = folders.filter((f) => f.parentId === parentId && f.id !== excludeId);
  if (!siblings.some((f) => f.name === base)) {
    return base;
  }
  let index = 2;
  while (siblings.some((f) => f.name === `${base} ${index}`)) {
    index += 1;
  }
  return `${base} ${index}`;
}

function collectDescendantFolderIds(folders: ProtocolHttpFolder[], rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        changed = true;
      }
    }
  }
  return ids;
}

function isFolderDescendant(
  folders: ProtocolHttpFolder[],
  folderId: string,
  maybeAncestorId: string,
): boolean {
  if (folderId === maybeAncestorId) {
    return true;
  }
  let current = folders.find((f) => f.id === folderId);
  while (current?.parentId) {
    if (current.parentId === maybeAncestorId) {
      return true;
    }
    current = folders.find((f) => f.id === current!.parentId);
  }
  return false;
}

interface ProtocolHttpLayoutState {
  folders: ProtocolHttpFolder[];
  /** collectionId → 父文件夹 id；缺省为根级 */
  collectionParents: Record<string, string | null>;
  /** requestId → 父文件夹 id；缺省为根级或所属 collection 下 */
  requestParents: Record<string, string | null>;
  /** 非 HTTP 协议条目 id → 父文件夹 id */
  entryParents: Record<string, string | null>;
  /** 同级节点顺序 */
  siblingOrder: Record<string, ProtocolTreeNodeKey[]>;
  expandedFolderIds: string[];
  expandedCollectionIds: string[];
  addFolder: (parentId: string | null, name: string) => ProtocolHttpFolder;
  renameFolder: (folderId: string, name: string) => boolean;
  deleteFolder: (folderId: string) => void;
  moveFolder: (folderId: string, newParentId: string | null) => boolean;
  setCollectionParent: (collectionId: string, parentId: string | null) => void;
  setRequestParent: (requestId: string, parentId: string | null) => void;
  setEntryParent: (entryId: string, parentId: string | null) => void;
  reorderSibling: (
    sourceKey: ProtocolTreeNodeKey,
    target: ProtocolDropTarget,
    beforeKey?: ProtocolTreeNodeKey | null,
  ) => void;
  moveNode: (sourceKey: ProtocolTreeNodeKey, target: ProtocolDropTarget) => boolean;
  placeNode: (
    sourceKey: ProtocolTreeNodeKey,
    target: ProtocolDropTarget,
    beforeKey?: ProtocolTreeNodeKey | null,
  ) => boolean;
  toggleFolderExpanded: (folderId: string) => void;
  toggleCollectionExpanded: (collectionId: string) => void;
  ensureFolderExpanded: (folderId: string) => void;
  ensureCollectionExpanded: (collectionId: string) => void;
  isFolderExpanded: (folderId: string) => boolean;
  isCollectionExpanded: (collectionId: string) => boolean;
}

const STORAGE_KEY = "omnipanel-protocol-http-layout.v1";

export const useProtocolHttpLayoutStore = create<ProtocolHttpLayoutState>()(
  persist(
    (set, get) => ({
      folders: [],
      collectionParents: {},
      requestParents: {},
      entryParents: {},
      siblingOrder: {},
      expandedFolderIds: [],
      expandedCollectionIds: [],

      addFolder: (parentId, name) => {
        const folder: ProtocolHttpFolder = {
          id: makeFolderId(),
          name: uniqueFolderName(get().folders, parentId, name),
          parentId,
        };
        set((state) => {
          const expandedFolderIds = [...state.expandedFolderIds, folder.id];
          if (parentId && !expandedFolderIds.includes(parentId)) {
            expandedFolderIds.push(parentId);
          }
          return {
            folders: [...state.folders, folder],
            expandedFolderIds,
          };
        });
        scheduleClientModuleSync();
        return folder;
      },

      renameFolder: (folderId, name) => {
        const trimmed = name.trim();
        if (!trimmed) return false;
        const folder = get().folders.find((f) => f.id === folderId);
        if (!folder) return false;
        const nextName = uniqueFolderName(get().folders, folder.parentId, trimmed, folderId);
        set((state) => ({
          folders: state.folders.map((f) => (f.id === folderId ? { ...f, name: nextName } : f)),
        }));
        scheduleClientModuleSync();
        return true;
      },

      deleteFolder: (folderId) => {
        const descendantIds = collectDescendantFolderIds(get().folders, folderId);
        set((state) => {
          const folders = state.folders.filter((f) => !descendantIds.has(f.id));
          const collectionParents = { ...state.collectionParents };
          const requestParents = { ...state.requestParents };
          const entryParents = { ...state.entryParents };
          // 文件夹级联删除：移除其下条目的父级映射（不再挪到根级）
          for (const [id, parentId] of Object.entries(collectionParents)) {
            if (parentId && descendantIds.has(parentId)) {
              delete collectionParents[id];
            }
          }
          for (const [id, parentId] of Object.entries(requestParents)) {
            if (parentId && descendantIds.has(parentId)) {
              delete requestParents[id];
            }
          }
          for (const [id, parentId] of Object.entries(entryParents)) {
            if (parentId && descendantIds.has(parentId)) {
              delete entryParents[id];
            }
          }
          const removedFolderKeys = new Set(
            [...descendantIds].map((id) => `folder:${id}`),
          );
          const siblingOrder: Record<string, ProtocolTreeNodeKey[]> = {};
          for (const [key, order] of Object.entries(state.siblingOrder)) {
            if (removedFolderKeys.has(key)) continue;
            siblingOrder[key] = order.filter((nodeKey) => {
              if (!nodeKey.startsWith("folder:")) return true;
              return !descendantIds.has(nodeKey.slice("folder:".length));
            });
          }
          return {
            folders,
            collectionParents,
            requestParents,
            entryParents,
            siblingOrder,
            expandedFolderIds: state.expandedFolderIds.filter((id) => !descendantIds.has(id)),
          };
        });
        scheduleClientModuleSync();
      },

      moveFolder: (folderId, newParentId) => {
        if (newParentId && isFolderDescendant(get().folders, newParentId, folderId)) {
          return false;
        }
        const folder = get().folders.find((f) => f.id === folderId);
        if (!folder) return false;
        set((state) => ({
          folders: state.folders.map((f) =>
            f.id === folderId ? { ...f, parentId: newParentId } : f,
          ),
        }));
        scheduleClientModuleSync();
        return true;
      },

      setCollectionParent: (collectionId, parentId) => {
        set((state) => ({
          collectionParents: { ...state.collectionParents, [collectionId]: parentId },
        }));
        scheduleClientModuleSync();
      },

      setRequestParent: (requestId, parentId) => {
        set((state) => ({
          requestParents: { ...state.requestParents, [requestId]: parentId },
        }));
        scheduleClientModuleSync();
      },

      setEntryParent: (entryId, parentId) => {
        set((state) => ({
          entryParents: { ...state.entryParents, [entryId]: parentId },
        }));
        scheduleClientModuleSync();
      },

      reorderSibling: (sourceKey, target, beforeKey = null) => {
        const key = parentKey(target);
        set((state) => {
          const nextOrder = { ...state.siblingOrder };
          for (const orderKey of Object.keys(nextOrder)) {
            nextOrder[orderKey] = nextOrder[orderKey].filter((k) => k !== sourceKey);
          }
          const siblings = [...(nextOrder[key] ?? [])];
          if (beforeKey) {
            const index = siblings.indexOf(beforeKey);
            if (index >= 0) {
              siblings.splice(index, 0, sourceKey);
            } else {
              siblings.push(sourceKey);
            }
          } else {
            siblings.push(sourceKey);
          }
          nextOrder[key] = siblings;
          return { siblingOrder: nextOrder };
        });
        scheduleClientModuleSync();
      },

      moveNode: (sourceKey, target) => get().placeNode(sourceKey, target, null),

      placeNode: (sourceKey, target, beforeKey = null) => {
        if (sourceKey.startsWith("folder:")) {
          const folderId = sourceKey.slice("folder:".length);
          if (target.kind === "collection") return false;
          const newParentId = target.kind === "root" ? null : target.folderId;
          if (!get().moveFolder(folderId, newParentId)) return false;
        } else if (sourceKey.startsWith("collection:")) {
          const collectionId = sourceKey.slice("collection:".length);
          if (target.kind === "collection") return false;
          const parentId = target.kind === "root" ? null : target.folderId;
          get().setCollectionParent(collectionId, parentId);
        } else if (sourceKey.startsWith("request:")) {
          const requestId = sourceKey.slice("request:".length);
          if (target.kind === "collection") {
            get().setRequestParent(requestId, null);
          } else {
            const parentId = target.kind === "root" ? null : target.folderId;
            get().setRequestParent(requestId, parentId);
          }
        } else if (sourceKey.startsWith("entry:")) {
          const entryId = sourceKey.slice("entry:".length);
          if (target.kind === "collection") return false;
          const parentId = target.kind === "root" ? null : target.folderId;
          get().setEntryParent(entryId, parentId);
        } else {
          return false;
        }
        get().reorderSibling(sourceKey, target, beforeKey);
        return true;
      },

      toggleFolderExpanded: (folderId) => {
        set((state) => {
          const expanded = new Set(state.expandedFolderIds);
          if (expanded.has(folderId)) expanded.delete(folderId);
          else expanded.add(folderId);
          return { expandedFolderIds: [...expanded] };
        });
      },

      toggleCollectionExpanded: (collectionId) => {
        set((state) => {
          const expanded = new Set(state.expandedCollectionIds);
          if (expanded.has(collectionId)) expanded.delete(collectionId);
          else expanded.add(collectionId);
          return { expandedCollectionIds: [...expanded] };
        });
      },

      ensureFolderExpanded: (folderId) => {
        set((state) => {
          if (state.expandedFolderIds.includes(folderId)) return state;
          return { expandedFolderIds: [...state.expandedFolderIds, folderId] };
        });
      },

      ensureCollectionExpanded: (collectionId) => {
        set((state) => {
          if (state.expandedCollectionIds.includes(collectionId)) return state;
          return { expandedCollectionIds: [...state.expandedCollectionIds, collectionId] };
        });
      },

      isFolderExpanded: (folderId) => get().expandedFolderIds.includes(folderId),
      isCollectionExpanded: (collectionId) => get().expandedCollectionIds.includes(collectionId),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(createSafeLocalStorage),
      partialize: (state) => ({
        folders: state.folders,
        collectionParents: state.collectionParents,
        requestParents: state.requestParents,
        entryParents: state.entryParents,
        siblingOrder: state.siblingOrder,
        expandedFolderIds: state.expandedFolderIds,
        expandedCollectionIds: state.expandedCollectionIds,
      }),
    },
  ),
);

export function protocolNodeKey(
  kind: "folder" | "collection" | "request" | "entry",
  id: string,
): ProtocolTreeNodeKey {
  return `${kind}:${id}`;
}

export { parentKey as protocolParentKey, collectDescendantFolderIds };

export type ProtocolHttpLayoutSnapshot = {
  folders: ProtocolHttpFolder[];
  collectionParents: Record<string, string | null>;
  requestParents: Record<string, string | null>;
  entryParents: Record<string, string | null>;
  siblingOrder: Record<string, ProtocolTreeNodeKey[]>;
  expandedFolderIds: string[];
  expandedCollectionIds: string[];
};

export function serializeProtocolHttpLayout(): ProtocolHttpLayoutSnapshot {
  const {
    folders,
    collectionParents,
    requestParents,
    entryParents,
    siblingOrder,
    expandedFolderIds,
    expandedCollectionIds,
  } = useProtocolHttpLayoutStore.getState();
  return {
    folders,
    collectionParents,
    requestParents,
    entryParents,
    siblingOrder,
    expandedFolderIds,
    expandedCollectionIds,
  };
}

function asNullableStringRecord(value: unknown): Record<string, string | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v == null) {
      out[k] = null;
    } else if (typeof v === "string") {
      out[k] = v.trim() ? v : null;
    }
  }
  return out;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function asSiblingOrder(value: unknown): Record<string, ProtocolTreeNodeKey[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, ProtocolTreeNodeKey[]> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!Array.isArray(v)) continue;
    out[k] = v.filter(
      (item): item is ProtocolTreeNodeKey => typeof item === "string",
    );
  }
  return out;
}

function parseProtocolFolders(value: unknown): ProtocolHttpFolder[] {
  if (!Array.isArray(value)) return [];
  const folders: ProtocolHttpFolder[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const folder = item as { id?: unknown; name?: unknown; parentId?: unknown };
    if (typeof folder.id !== "string" || !folder.id.trim()) continue;
    if (typeof folder.name !== "string") continue;
    folders.push({
      id: folder.id,
      name: folder.name,
      parentId:
        typeof folder.parentId === "string" && folder.parentId.trim()
          ? folder.parentId
          : null,
    });
  }
  return folders;
}

function parseProtocolHttpLayoutSnapshot(data: unknown): ProtocolHttpLayoutSnapshot | null {
  let obj = data;
  if (typeof data === "string") {
    try {
      obj = JSON.parse(data) as unknown;
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const raw = obj as {
    folders?: unknown;
    collectionParents?: unknown;
    requestParents?: unknown;
    entryParents?: unknown;
    siblingOrder?: unknown;
    expandedFolderIds?: unknown;
    expandedCollectionIds?: unknown;
  };
  if (!Array.isArray(raw.folders)) return null;
  return {
    folders: parseProtocolFolders(raw.folders),
    collectionParents: asNullableStringRecord(raw.collectionParents),
    requestParents: asNullableStringRecord(raw.requestParents),
    entryParents: asNullableStringRecord(raw.entryParents),
    siblingOrder: asSiblingOrder(raw.siblingOrder),
    expandedFolderIds: asStringArray(raw.expandedFolderIds),
    expandedCollectionIds: asStringArray(raw.expandedCollectionIds),
  };
}

const EMPTY_PROTOCOL_HTTP_LAYOUT: ProtocolHttpLayoutSnapshot = {
  folders: [],
  collectionParents: {},
  requestParents: {},
  entryParents: {},
  siblingOrder: {},
  expandedFolderIds: [],
  expandedCollectionIds: [],
};

/**
 * 云端拉取后写入本机。
 * merge：旧快照无此字段时保留本机；replace：切换团队时缺字段则清空，避免串数据。
 */
export function applyProtocolHttpLayout(
  data: unknown | null | undefined,
  mode: "merge" | "replace" = "merge",
): void {
  const parsed = parseProtocolHttpLayoutSnapshot(data);
  if (!parsed) {
    if (mode === "replace") {
      useProtocolHttpLayoutStore.setState(EMPTY_PROTOCOL_HTTP_LAYOUT);
    }
    return;
  }
  useProtocolHttpLayoutStore.setState({
    folders: parsed.folders,
    collectionParents: parsed.collectionParents,
    requestParents: parsed.requestParents,
    entryParents: parsed.entryParents,
    siblingOrder: parsed.siblingOrder,
    expandedFolderIds: parsed.expandedFolderIds,
    expandedCollectionIds: parsed.expandedCollectionIds,
  });
}
