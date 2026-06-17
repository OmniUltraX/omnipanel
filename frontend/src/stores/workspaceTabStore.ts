import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { DbWorkspaceTab } from "../modules/database/workspaceTabs";

// --- Snapshot types ---

export type TerminalTabSnapshot = {
  module: "terminal";
  id: string;
  label: string;
  sessionType: "local" | "remote";
  resourceId: string;
  shellLabel: string;
  cwd: string;
  purpose: string;
};

export type DbTabSnapshot = {
  module: "database";
  id: string;
  label: string;
  /** 原始 DbWorkspaceTab 的 kind + 字段 */
  tab: DbWorkspaceTab;
  /** 该 tab 当前的模式（sql / data） */
  tabMode?: "data" | "sql";
};

export type DockerTabSnapshot = {
  module: "docker";
  id: string;
  label: string;
  /** "logs" | "terminal" */
  subTab: "logs" | "terminal";
  connectionId: string;
  containerId: string;
  containerName: string;
};

export type WorkspaceTabSnapshot = TerminalTabSnapshot | DbTabSnapshot | DockerTabSnapshot;

// --- Store state ---

interface WorkspaceTabState {
  /** workspaceId → tab snapshot 列表 */
  tabsByWorkspace: Record<string, WorkspaceTabSnapshot[]>;

  // --- CRUD ---
  saveTabs: (workspaceId: string, tabs: WorkspaceTabSnapshot[]) => void;
  addTab: (workspaceId: string, tab: WorkspaceTabSnapshot) => void;
  removeTab: (workspaceId: string, tabId: string) => void;
  getTabs: (workspaceId: string) => WorkspaceTabSnapshot[];
  clearWorkspace: (workspaceId: string) => void;
  removeWorkspace: (workspaceId: string) => void;
}

export const useWorkspaceTabStore = create<WorkspaceTabState>()(
  persist(
    (set, get) => ({
      tabsByWorkspace: {},

      saveTabs: (workspaceId, tabs) =>
        set((state) => ({
          tabsByWorkspace: { ...state.tabsByWorkspace, [workspaceId]: tabs },
        })),

      addTab: (workspaceId, tab) =>
        set((state) => {
          const existing = state.tabsByWorkspace[workspaceId] ?? [];
          // 去重：同 module + 同 id 不重复添加
          if (existing.some((t) => t.id === tab.id && t.module === tab.module)) {
            return state;
          }
          return {
            tabsByWorkspace: { ...state.tabsByWorkspace, [workspaceId]: [...existing, tab] },
          };
        }),

      removeTab: (workspaceId, tabId) =>
        set((state) => {
          const existing = state.tabsByWorkspace[workspaceId];
          if (!existing) return state;
          return {
            tabsByWorkspace: {
              ...state.tabsByWorkspace,
              [workspaceId]: existing.filter((t) => t.id !== tabId),
            },
          };
        }),

      getTabs: (workspaceId) => get().tabsByWorkspace[workspaceId] ?? [],

      clearWorkspace: (workspaceId) =>
        set((state) => {
          const { [workspaceId]: _, ...rest } = state.tabsByWorkspace;
          return { tabsByWorkspace: rest };
        }),

      removeWorkspace: (workspaceId) =>
        set((state) => {
          const { [workspaceId]: _, ...rest } = state.tabsByWorkspace;
          return { tabsByWorkspace: rest };
        }),
    }),
    {
      name: "omnipanel-workspace-tabs",
      version: 2,
      storage: createJSONStorage(() => localStorage),
      migrate: () => ({ tabsByWorkspace: {} }),
    },
  ),
);
