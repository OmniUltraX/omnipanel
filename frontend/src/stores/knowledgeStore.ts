import { create } from "zustand";
import { persist } from "zustand/middleware";
import { commands, type KnowledgeEntry, type KnowledgeSearchResult } from "../ipc/bindings";

/** 知识条目类型标签 */
export type KnowledgeKind = "snippet" | "case" | "ai";

/** 风险等级 */
export type RiskLevel = "safe" | "readonly" | "medium" | "dangerous";

/** 环境标签 */
export type KnowledgeEnvTag = "dev" | "staging" | "production";

/** 活跃标签页 */
export type KnowledgeTab = "all" | "snippet" | "case" | "ai";

interface KnowledgeStore {
  // ── 数据 ──────────────────────────────────────────────
  entries: KnowledgeEntry[];
  searchResults: KnowledgeSearchResult[];
  allTags: string[];

  // ── UI 状态 ──────────────────────────────────────────
  activeTab: KnowledgeTab;
  searchQuery: string;
  selectedTag: string | null;
  selectedEntryId: string | null;
  editingEntry: KnowledgeEntry | null;
  isLoading: boolean;
  error: string | null;

  // ── 数据操作 ─────────────────────────────────────────
  loadEntries: (kind?: string, tag?: string) => Promise<void>;
  loadTags: () => Promise<void>;
  search: (query: string, kind?: string) => Promise<void>;
  saveEntry: (entry: KnowledgeEntry) => Promise<boolean>;
  deleteEntry: (id: string) => Promise<void>;
  incrementUsage: (id: string) => Promise<void>;

  // ── UI 操作 ──────────────────────────────────────────
  setActiveTab: (tab: KnowledgeTab) => void;
  setSearchQuery: (query: string) => void;
  setSelectedTag: (tag: string | null) => void;
  setSelectedEntry: (id: string | null) => void;
  setEditingEntry: (entry: KnowledgeEntry | null) => void;
  clearError: () => void;
}

export const useKnowledgeStore = create<KnowledgeStore>()(
  persist(
    (set, get) => ({
      // ── 数据 ─────────────────────────────────────────
      entries: [],
      searchResults: [],
      allTags: [],

      // ── UI 状态 ──────────────────────────────────────
      activeTab: "all",
      searchQuery: "",
      selectedTag: null,
      selectedEntryId: null,
      editingEntry: null,
      isLoading: false,
      error: null,

      // ── 数据操作 ─────────────────────────────────────

      loadEntries: async (kind?: string, tag?: string) => {
        set({ isLoading: true, error: null });
        try {
          const res = await commands.knowledgeList(kind ?? null, tag ?? null);
          if (res.status === "ok") {
            set({ entries: res.data, isLoading: false });
          } else {
            set({ error: res.error.message, isLoading: false });
          }
        } catch (e) {
          set({ error: String(e), isLoading: false });
        }
      },

      loadTags: async () => {
        try {
          const res = await commands.knowledgeTags();
          if (res.status === "ok") {
            set({ allTags: res.data });
          }
        } catch (e) {
          // 降级：标签加载失败不阻断页面
          console.warn("loadTags failed", e);
        }
      },

      search: async (query: string, kind?: string) => {
        if (!query.trim()) {
          set({ searchResults: [] });
          return;
        }
        set({ isLoading: true, error: null });
        try {
          const res = await commands.knowledgeSearch(query, kind ?? null);
          if (res.status === "ok") {
            set({ searchResults: res.data, isLoading: false });
          } else {
            set({ error: res.error.message, isLoading: false });
          }
        } catch (e) {
          set({ error: String(e), isLoading: false });
        }
      },

      saveEntry: async (entry: KnowledgeEntry) => {
        try {
          const res = await commands.knowledgeSave(entry);
          if (res.status === "ok") {
            // 保存成功后刷新列表
            const state = get();
            const kindFilter =
              state.activeTab !== "all" ? state.activeTab : undefined;
            await state.loadEntries(kindFilter, state.selectedTag ?? undefined);
            await state.loadTags();
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
              selectedEntryId:
                state.selectedEntryId === id ? null : state.selectedEntryId,
              editingEntry:
                state.editingEntry?.id === id ? null : state.editingEntry,
            }));
          } else {
            set({ error: res.error.message });
          }
        } catch (e) {
          set({ error: String(e) });
        }
      },

      incrementUsage: async (id: string) => {
        try {
          const res = await commands.knowledgeIncrementUsage(id);
          if (res.status === "ok") {
            set((state) => ({
              entries: state.entries.map((e) =>
                e.id === id ? { ...e, usageCount: (e.usageCount ?? 0) + 1 } : e
              ),
            }));
          }
        } catch (e) {
          console.warn("incrementUsage failed", e);
        }
      },

      // ── UI 操作 ──────────────────────────────────────

      setActiveTab: (tab) => set({ activeTab: tab }),

      setSearchQuery: (query) => set({ searchQuery: query }),

      setSelectedTag: (tag) => set({ selectedTag: tag }),

      setSelectedEntry: (id) => set({ selectedEntryId: id }),

      setEditingEntry: (entry) => set({ editingEntry: entry }),

      clearError: () => set({ error: null }),
    }),
    {
      name: "omnipanel-knowledge-store",
      partialize: (state) => ({
        activeTab: state.activeTab,
        selectedTag: state.selectedTag,
      }),
    }
  )
);
