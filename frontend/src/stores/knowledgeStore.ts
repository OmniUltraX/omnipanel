import { create } from "zustand";
import { persist } from "zustand/middleware";
import { commands, type KnowledgeEntry } from "../ipc/bindings";
import {
  collectDescendantIds,
  createEmptyEntry,
  isKnowledgeFolder,
  newKnowledgeId,
  nextSortOrder,
  normalizeParentId,
} from "../modules/knowledge/knowledgeTree";

interface KnowledgeStore {
  entries: KnowledgeEntry[];
  expandedIds: string[];
  selectedEntryId: string | null;
  searchQuery: string;
  isLoading: boolean;
  error: string | null;

  loadEntries: () => Promise<void>;
  saveEntry: (entry: KnowledgeEntry) => Promise<boolean>;
  deleteEntry: (id: string) => Promise<void>;
  deleteEntryRecursive: (id: string) => Promise<void>;
  duplicateEntry: (id: string) => Promise<string | null>;
  moveEntry: (id: string, parentId: string, sortOrder: number) => Promise<void>;
  createFolder: (parentId?: string) => Promise<string | null>;
  createDocument: (parentId?: string) => Promise<string | null>;
  importPdfFromPath: (path: string, parentId?: string) => Promise<string | null>;
  renameEntry: (id: string, title: string) => Promise<boolean>;

  setSearchQuery: (query: string) => void;
  setSelectedEntry: (id: string | null) => void;
  toggleExpanded: (id: string) => void;
  setExpanded: (id: string, open: boolean) => void;
  clearError: () => void;
}

export const useKnowledgeStore = create<KnowledgeStore>()(
  persist(
    (set, get) => ({
      entries: [],
      expandedIds: [],
      selectedEntryId: null,
      searchQuery: "",
      isLoading: false,
      error: null,

      loadEntries: async () => {
        set({ isLoading: true, error: null });
        try {
          const res = await commands.knowledgeList(null, null);
          if (res.status === "ok") {
            set({ entries: res.data, isLoading: false });
          } else {
            set({ error: res.error.message, isLoading: false });
          }
        } catch (e) {
          set({ error: String(e), isLoading: false });
        }
      },

      saveEntry: async (entry: KnowledgeEntry) => {
        try {
          const res = await commands.knowledgeSave({
            ...entry,
            updatedAt: Date.now(),
          });
          if (res.status === "ok") {
            set((state) => {
              const exists = state.entries.some((e) => e.id === entry.id);
              const entries = exists
                ? state.entries.map((e) => (e.id === entry.id ? entry : e))
                : [...state.entries, entry];
              return { entries };
            });
            return true;
          }
          set({ error: res.error.message });
          return false;
        } catch (e) {
          set({ error: String(e) });
          return false;
        }
      },

      deleteEntry: async (id: string) => {
        try {
          const res = await commands.knowledgeDelete(id);
          if (res.status === "ok") {
            set((state) => ({
              entries: state.entries.filter((e) => e.id !== id),
              selectedEntryId: state.selectedEntryId === id ? null : state.selectedEntryId,
              expandedIds: state.expandedIds.filter((x) => x !== id),
            }));
          } else {
            set({ error: res.error.message });
          }
        } catch (e) {
          set({ error: String(e) });
        }
      },

      deleteEntryRecursive: async (id: string) => {
        const { entries, deleteEntry } = get();
        const descendants = collectDescendantIds(entries, id);
        for (const childId of [...descendants].reverse()) {
          await deleteEntry(childId);
        }
        await deleteEntry(id);
      },

      duplicateEntry: async (id: string) => {
        const source = get().entries.find((e) => e.id === id);
        if (!source) return null;
        const copy: KnowledgeEntry = {
          ...source,
          id: newKnowledgeId(),
          title: `${source.title} (副本)`,
          parentId: normalizeParentId(source.parentId),
          sortOrder: nextSortOrder(get().entries, normalizeParentId(source.parentId)),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        const ok = await get().saveEntry(copy);
        return ok ? copy.id : null;
      },

      moveEntry: async (id: string, parentId: string, sortOrder: number) => {
        const entry = get().entries.find((e) => e.id === id);
        if (!entry) return;
        const normalizedParent = normalizeParentId(parentId);
        if (isKnowledgeFolder(entry)) {
          const descendants = collectDescendantIds(get().entries, id);
          if (descendants.includes(normalizedParent) || normalizedParent === id) {
            return;
          }
        }
        await get().saveEntry({
          ...entry,
          parentId: normalizedParent,
          sortOrder,
        });
      },

      createFolder: async (parentId = "") => {
        const parent = normalizeParentId(parentId);
        const entry = createEmptyEntry({
          title: "新文件夹",
          nodeType: "folder",
          parentId: parent,
          sortOrder: nextSortOrder(get().entries, parent),
        });
        const ok = await get().saveEntry(entry);
        if (!ok) return null;
        if (parent) {
          get().setExpanded(parent, true);
        }
        get().setExpanded(entry.id, true);
        return entry.id;
      },

      createDocument: async (parentId = "") => {
        const parent = normalizeParentId(parentId);
        const entry = createEmptyEntry({
          title: "未命名文档",
          nodeType: "document",
          parentId: parent,
          sortOrder: nextSortOrder(get().entries, parent),
        });
        const ok = await get().saveEntry(entry);
        if (!ok) return null;
        if (parent) {
          get().setExpanded(parent, true);
        }
        get().setSelectedEntry(entry.id);
        return entry.id;
      },

      importPdfFromPath: async (path: string, parentId = "") => {
        const parent = normalizeParentId(parentId);
        try {
          const res = await commands.knowledgeImportPdf(path, parent || null);
          if (res.status === "ok") {
            const entry = res.data;
            set((state) => ({
              entries: state.entries.some((e) => e.id === entry.id)
                ? state.entries.map((e) => (e.id === entry.id ? entry : e))
                : [...state.entries, entry],
            }));
            if (parent) {
              get().setExpanded(parent, true);
            }
            get().setSelectedEntry(entry.id);
            return entry.id;
          }
          set({ error: res.error.message });
          return null;
        } catch (e) {
          set({ error: String(e) });
          return null;
        }
      },

      renameEntry: async (id: string, title: string) => {
        const trimmed = title.trim();
        if (!trimmed) return false;
        const entry = get().entries.find((e) => e.id === id);
        if (!entry) return false;
        return get().saveEntry({ ...entry, title: trimmed });
      },

      setSearchQuery: (query) => set({ searchQuery: query }),
      setSelectedEntry: (id) => set({ selectedEntryId: id }),
      toggleExpanded: (id) =>
        set((state) => ({
          expandedIds: state.expandedIds.includes(id)
            ? state.expandedIds.filter((x) => x !== id)
            : [...state.expandedIds, id],
        })),
      setExpanded: (id, open) =>
        set((state) => ({
          expandedIds: open
            ? state.expandedIds.includes(id)
              ? state.expandedIds
              : [...state.expandedIds, id]
            : state.expandedIds.filter((x) => x !== id),
        })),
      clearError: () => set({ error: null }),
    }),
    {
      name: "omnipanel-knowledge-store",
      partialize: (state) => ({
        expandedIds: state.expandedIds,
        selectedEntryId: state.selectedEntryId,
      }),
    },
  ),
);
