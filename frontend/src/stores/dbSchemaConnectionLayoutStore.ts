import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type SchemaConnectionFolder = {
  id: string;
  name: string;
  parentId: string | null;
};

interface DbSchemaConnectionLayoutState {
  folders: SchemaConnectionFolder[];
  /** connId → 父文件夹 id；缺省或 null 表示根级 */
  connectionParents: Record<string, string | null>;
  hydrated: boolean;
  hydrate: () => void;
  addFolder: (parentId: string | null, name: string) => SchemaConnectionFolder;
  renameFolder: (folderId: string, name: string) => boolean;
  deleteFolder: (folderId: string) => void;
  moveFolder: (folderId: string, newParentId: string | null) => boolean;
  setConnectionParent: (connId: string, parentId: string | null) => void;
}

const STORAGE_KEY = "omnipanel-db-schema-connection-layout.v1";

function makeFolderId(): string {
  return `conn-folder:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function uniqueFolderName(
  folders: SchemaConnectionFolder[],
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

function collectDescendantFolderIds(folders: SchemaConnectionFolder[], rootId: string): Set<string> {
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
  folders: SchemaConnectionFolder[],
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

export const useDbSchemaConnectionLayoutStore = create<DbSchemaConnectionLayoutState>()(
  persist(
    (set, get) => ({
      folders: [],
      connectionParents: {},
      hydrated: false,
      hydrate: () => set({ hydrated: true }),

      addFolder: (parentId, name) => {
        const folder: SchemaConnectionFolder = {
          id: makeFolderId(),
          name: uniqueFolderName(get().folders, parentId, name),
          parentId,
        };
        set((state) => ({ folders: [...state.folders, folder] }));
        return folder;
      },

      renameFolder: (folderId, name) => {
        const trimmed = name.trim();
        if (!trimmed) {
          return false;
        }
        const folder = get().folders.find((f) => f.id === folderId);
        if (!folder) {
          return false;
        }
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
          const connectionParents = { ...state.connectionParents };
          for (const [connId, parentId] of Object.entries(connectionParents)) {
            if (parentId && descendantIds.has(parentId)) {
              connectionParents[connId] = null;
            }
          }
          return { folders, connectionParents };
        });
      },

      moveFolder: (folderId, newParentId) => {
        if (newParentId && isFolderDescendant(get().folders, newParentId, folderId)) {
          return false;
        }
        const folder = get().folders.find((f) => f.id === folderId);
        if (!folder) {
          return false;
        }
        set((state) => ({
          folders: state.folders.map((f) =>
            f.id === folderId ? { ...f, parentId: newParentId } : f,
          ),
        }));
        return true;
      },

      setConnectionParent: (connId, parentId) => {
        set((state) => ({
          connectionParents: { ...state.connectionParents, [connId]: parentId },
        }));
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        folders: state.folders,
        connectionParents: state.connectionParents,
      }),
      onRehydrateStorage: () => (state) => {
        state?.hydrate();
      },
    },
  ),
);

export function schemaConnectionFolderNodeId(folderId: string): string {
  return folderId.startsWith("conn-folder:") ? folderId : `conn-folder:${folderId}`;
}
