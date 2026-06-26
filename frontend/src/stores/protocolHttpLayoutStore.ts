import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type ProtocolHttpFolder = {
  id: string;
  name: string;
  parentId: string | null;
};

export type ProtocolTreeNodeKey =
  | `folder:${string}`
  | `collection:${string}`
  | `request:${string}`;

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
  reorderSibling: (
    sourceKey: ProtocolTreeNodeKey,
    target: ProtocolDropTarget,
    beforeKey?: ProtocolTreeNodeKey | null,
  ) => void;
  moveNode: (sourceKey: ProtocolTreeNodeKey, target: ProtocolDropTarget) => boolean;
  toggleFolderExpanded: (folderId: string) => void;
  toggleCollectionExpanded: (collectionId: string) => void;
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
        return true;
      },

      deleteFolder: (folderId) => {
        const descendantIds = collectDescendantFolderIds(get().folders, folderId);
        set((state) => {
          const folders = state.folders.filter((f) => !descendantIds.has(f.id));
          const collectionParents = { ...state.collectionParents };
          const requestParents = { ...state.requestParents };
          for (const [id, parentId] of Object.entries(collectionParents)) {
            if (parentId && descendantIds.has(parentId)) {
              collectionParents[id] = null;
            }
          }
          for (const [id, parentId] of Object.entries(requestParents)) {
            if (parentId && descendantIds.has(parentId)) {
              requestParents[id] = null;
            }
          }
          const siblingOrder = { ...state.siblingOrder };
          for (const key of Object.keys(siblingOrder)) {
            siblingOrder[key] = siblingOrder[key].filter(
              (nodeKey) => !nodeKey.startsWith(`folder:${folderId}`),
            );
          }
          return {
            folders,
            collectionParents,
            requestParents,
            siblingOrder,
            expandedFolderIds: state.expandedFolderIds.filter((id) => !descendantIds.has(id)),
          };
        });
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
        return true;
      },

      setCollectionParent: (collectionId, parentId) => {
        set((state) => ({
          collectionParents: { ...state.collectionParents, [collectionId]: parentId },
        }));
      },

      setRequestParent: (requestId, parentId) => {
        set((state) => ({
          requestParents: { ...state.requestParents, [requestId]: parentId },
        }));
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
      },

      moveNode: (sourceKey, target) => {
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
        } else {
          return false;
        }
        get().reorderSibling(sourceKey, target);
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

      isFolderExpanded: (folderId) => get().expandedFolderIds.includes(folderId),
      isCollectionExpanded: (collectionId) => get().expandedCollectionIds.includes(collectionId),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        folders: state.folders,
        collectionParents: state.collectionParents,
        requestParents: state.requestParents,
        siblingOrder: state.siblingOrder,
        expandedFolderIds: state.expandedFolderIds,
        expandedCollectionIds: state.expandedCollectionIds,
      }),
    },
  ),
);

export function protocolNodeKey(
  kind: "folder" | "collection" | "request",
  id: string,
): ProtocolTreeNodeKey {
  return `${kind}:${id}`;
}

export { parentKey as protocolParentKey };
