import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createSafeLocalStorage } from "../lib/zustandPersistStorage";
import { scheduleClientModuleSync } from "../modules/clientSync/moduleSync";

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
        scheduleClientModuleSync();
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
        scheduleClientModuleSync();
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
        scheduleClientModuleSync();
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
        scheduleClientModuleSync();
        return true;
      },

      setConnectionParent: (connId, parentId) => {
        set((state) => ({
          connectionParents: { ...state.connectionParents, [connId]: parentId },
        }));
        scheduleClientModuleSync();
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(createSafeLocalStorage),
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

export type DatabaseSidebarTreeSnapshot = {
  folders: SchemaConnectionFolder[];
  connectionParents: Record<string, string | null>;
};

export function serializeDatabaseSidebarTree(): DatabaseSidebarTreeSnapshot {
  const { folders, connectionParents } = useDbSchemaConnectionLayoutStore.getState();
  return { folders, connectionParents };
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

function parseDatabaseSidebarTreeSnapshot(data: unknown): DatabaseSidebarTreeSnapshot | null {
  let obj = data;
  if (typeof data === "string") {
    try {
      obj = JSON.parse(data) as unknown;
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const raw = obj as { folders?: unknown; connectionParents?: unknown };
  if (!Array.isArray(raw.folders)) return null;
  const folders: SchemaConnectionFolder[] = [];
  for (const item of raw.folders) {
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
  return {
    folders,
    connectionParents: asNullableStringRecord(raw.connectionParents),
  };
}

const EMPTY_DATABASE_SIDEBAR_TREE: DatabaseSidebarTreeSnapshot = {
  folders: [],
  connectionParents: {},
};

/**
 * 云端拉取后写入本机。
 * merge：旧快照无此字段时保留本机；replace：切换团队时缺字段则清空，避免串数据。
 */
export function applyDatabaseSidebarTree(
  data: unknown | null | undefined,
  mode: "merge" | "replace" = "merge",
): void {
  const parsed = parseDatabaseSidebarTreeSnapshot(data);
  if (!parsed) {
    if (mode === "replace") {
      useDbSchemaConnectionLayoutStore.setState(EMPTY_DATABASE_SIDEBAR_TREE);
    }
    return;
  }
  useDbSchemaConnectionLayoutStore.setState({
    folders: parsed.folders,
    connectionParents: parsed.connectionParents,
  });
}
