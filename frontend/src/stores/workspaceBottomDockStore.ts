import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { SerializedDockview } from "dockview-core";
import {
  collectPanelIds,
  createDefaultLayout,
  mergePanelsIntoLayout,
  removePanelFromLayout,
  isLayoutUsable,
} from "../components/dock/dockViewLayout";
import type { WorkspaceTabSnapshot } from "./workspaceTabStore";
import type { WorkspaceInfo } from "./workspaceStore";
import {
  defaultWorkspaceActiveTabId,
  isWorkspaceBuiltinTab,
  isWorkspaceBuiltinTabId,
  normalizeWorkspaceTabs,
} from "../lib/workspaceBuiltinPanels";

export type WorkspaceDockTabKind = "mirrored" | "payload" | "builtin";

/** 每个工作区底部 dock 最多容纳的面板数 */
export const MAX_WORKSPACE_PANELS = 15;

export interface WorkspaceDockTab {
  id: string;
  label: string;
  kind: WorkspaceDockTabKind;
  /** 面板类型：同源模块面板共享类型，用于 tab group 折叠 */
  panelType?: string;
  /** 序列化快照（复制/移动到工作区） */
  payload?: WorkspaceTabSnapshot;
  /** @deprecated 旧版内置面板类型，迁移后不再创建 */
  builtin?: "board" | "ai";
  closable?: boolean;
}

/** 解析工作区 dock tab 的面板类型 */
export function resolveWorkspaceDockPanelType(tab: WorkspaceDockTab): string {
  if (tab.panelType) return tab.panelType;
  return "unknown";
}

function tabsNeedNormalize(
  tabs: WorkspaceDockTab[] | undefined,
): WorkspaceDockTab[] {
  return normalizeWorkspaceTabs(tabs);
}

function normalizedTabsChanged(
  before: WorkspaceDockTab[] | undefined,
  after: WorkspaceDockTab[],
): boolean {
  const prev = before ?? [];
  if (prev.length !== after.length) return true;
  for (let i = 0; i < after.length; i++) {
    if (after[i]?.id !== prev[i]?.id) return true;
  }
  return false;
}

/** 组件侧派生 tabs 时使用；勿放入 zustand selector。 */
export function resolveWorkspaceTabs(
  workspace: WorkspaceInfo,
  tabs: WorkspaceDockTab[] | undefined,
): WorkspaceDockTab[] {
  return tabsNeedNormalize(tabs);
}

export function resolveWorkspaceActiveTabId(
  _workspace: WorkspaceInfo,
  tabs: WorkspaceDockTab[],
  activeTabId: string | undefined,
): string {
  if (tabs.length === 0) return "";
  if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) {
    return activeTabId;
  }
  return tabs[0]?.id ?? "";
}

interface WorkspaceBottomDockState {
  tabsByWorkspace: Record<string, WorkspaceDockTab[]>;
  layoutByWorkspace: Record<string, SerializedDockview | null>;
  activeTabByWorkspace: Record<string, string>;

  ensureWorkspaceData: (workspaceId: string, workspace: WorkspaceInfo) => void;
  setLayout: (workspaceId: string, layout: SerializedDockview | null) => void;
  setActiveTabId: (workspaceId: string, tabId: string) => void;
  addMirroredTab: (
    workspaceId: string,
    workspace: WorkspaceInfo,
    tab: Omit<WorkspaceDockTab, "kind"> & { kind?: "mirrored" },
  ) => WorkspaceDockTab;
  addPayloadTab: (
    workspaceId: string,
    workspace: WorkspaceInfo,
    tab: Omit<WorkspaceDockTab, "kind"> & { payload: WorkspaceTabSnapshot },
  ) => WorkspaceDockTab;
  removeTab: (workspaceId: string, workspace: WorkspaceInfo, tabId: string) => void;
  /** 删除工作区时清理底部 dock 持久化数据 */
  removeWorkspaceData: (workspaceId: string) => void;
  /** 重置全部底部工作区布局与 Tab（清除应用缓存时使用） */
  resetAll: () => void;
}

export const useWorkspaceBottomDockStore = create<WorkspaceBottomDockState>()(
  persist(
    (set, get) => ({
      tabsByWorkspace: {},
      layoutByWorkspace: {},
      activeTabByWorkspace: {},

      ensureWorkspaceData: (workspaceId, workspace) => {
        const existing = get().tabsByWorkspace[workspaceId];
        const merged = tabsNeedNormalize(existing);
        if (existing !== undefined && !normalizedTabsChanged(existing, merged)) {
          return;
        }

        const prevActive = get().activeTabByWorkspace[workspaceId];
        const nextActive =
          prevActive && merged.some((tab) => tab.id === prevActive)
            ? prevActive
            : defaultWorkspaceActiveTabId(merged);

        set((state) => ({
          tabsByWorkspace: {
            ...state.tabsByWorkspace,
            [workspaceId]: merged,
          },
          layoutByWorkspace: {
            ...state.layoutByWorkspace,
            [workspaceId]:
              existing === undefined || normalizedTabsChanged(existing, merged)
                ? null
                : state.layoutByWorkspace[workspaceId] ?? null,
          },
          activeTabByWorkspace: {
            ...state.activeTabByWorkspace,
            [workspaceId]: nextActive,
          },
        }));
      },

      setLayout: (workspaceId, layout) =>
        set((state) => ({
          layoutByWorkspace: { ...state.layoutByWorkspace, [workspaceId]: layout },
        })),

      setActiveTabId: (workspaceId, tabId) =>
        set((state) => ({
          activeTabByWorkspace: { ...state.activeTabByWorkspace, [workspaceId]: tabId },
        })),

      addMirroredTab: (workspaceId, _workspace, tab) => {
        const nextTab: WorkspaceDockTab = {
          ...tab,
          kind: "mirrored",
          panelType: tab.panelType ?? "unknown",
          closable: tab.closable !== false,
        };
        set((state) => {
          const current = tabsNeedNormalize(state.tabsByWorkspace[workspaceId]);
          if (current.length >= MAX_WORKSPACE_PANELS && !current.some((item) => item.id === nextTab.id)) {
            return state;
          }
          const tabs = current.some((item) => item.id === nextTab.id)
            ? current.map((item) => (item.id === nextTab.id ? nextTab : item))
            : [...current, nextTab];
          return {
            tabsByWorkspace: { ...state.tabsByWorkspace, [workspaceId]: tabs },
            activeTabByWorkspace: {
              ...state.activeTabByWorkspace,
              [workspaceId]: nextTab.id,
            },
          };
        });
        return nextTab;
      },

      addPayloadTab: (workspaceId, _workspace, tab) => {
        const nextTab: WorkspaceDockTab = {
          ...tab,
          kind: "payload",
          panelType: tab.panelType ?? tab.payload.module,
          closable: tab.closable !== false,
        };
        set((state) => {
          const current = tabsNeedNormalize(state.tabsByWorkspace[workspaceId]);
          if (current.length >= MAX_WORKSPACE_PANELS && !current.some((item) => item.id === nextTab.id)) {
            return state;
          }
          const isUpdate = current.some((item) => item.id === nextTab.id);
          const tabs = isUpdate
            ? current.map((item) => (item.id === nextTab.id ? nextTab : item))
            : [...current, nextTab];
          const tabIds = tabs.map((item) => item.id);
          const prevLayout = state.layoutByWorkspace[workspaceId] ?? null;
          const nextLayout =
            mergePanelsIntoLayout(prevLayout, tabIds, nextTab.id) ??
            createDefaultLayout(tabIds, nextTab.id);

          return {
            tabsByWorkspace: { ...state.tabsByWorkspace, [workspaceId]: tabs },
            layoutByWorkspace: {
              ...state.layoutByWorkspace,
              [workspaceId]: nextLayout,
            },
            activeTabByWorkspace: {
              ...state.activeTabByWorkspace,
              [workspaceId]: nextTab.id,
            },
          };
        });
        return nextTab;
      },

      removeTab: (workspaceId, _workspace, tabId) => {
        set((state) => {
          const current = state.tabsByWorkspace[workspaceId] ?? [];
          const removed = current.find((tab) => tab.id === tabId);
          if (!removed || isWorkspaceBuiltinTab(removed)) return state;
          const tabs = current.filter((tab) => tab.id !== tabId);
          const prevLayout = state.layoutByWorkspace[workspaceId] ?? null;
          const nextLayout = removePanelFromLayout(prevLayout, tabId);
          const active = state.activeTabByWorkspace[workspaceId];
          const nextActive =
            active === tabId ? (tabs[0]?.id ?? "") : (active ?? tabs[0]?.id ?? "");
          return {
            tabsByWorkspace: { ...state.tabsByWorkspace, [workspaceId]: tabs },
            layoutByWorkspace: {
              ...state.layoutByWorkspace,
              [workspaceId]: tabs.length === 0 ? null : nextLayout,
            },
            activeTabByWorkspace: {
              ...state.activeTabByWorkspace,
              [workspaceId]: nextActive,
            },
          };
        });
      },

      removeWorkspaceData: (workspaceId) => {
        set((state) => {
          const tabsByWorkspace = { ...state.tabsByWorkspace };
          const layoutByWorkspace = { ...state.layoutByWorkspace };
          const activeTabByWorkspace = { ...state.activeTabByWorkspace };
          delete tabsByWorkspace[workspaceId];
          delete layoutByWorkspace[workspaceId];
          delete activeTabByWorkspace[workspaceId];
          return {
            tabsByWorkspace,
            layoutByWorkspace,
            activeTabByWorkspace,
          };
        });
      },

      resetAll: () =>
        set({
          tabsByWorkspace: {},
          layoutByWorkspace: {},
          activeTabByWorkspace: {},
        }),
    }),
    {
      name: "omnipanel.workspace-bottom-dock.v3",
      version: 5,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        tabsByWorkspace: state.tabsByWorkspace,
        layoutByWorkspace: state.layoutByWorkspace,
        activeTabByWorkspace: state.activeTabByWorkspace,
      }),
      migrate: (persistedState, fromVersion) => {
        const p = persistedState as
          | {
              layoutByWorkspace?: Record<string, SerializedDockview | null>;
              tabsByWorkspace?: Record<string, WorkspaceDockTab[]>;
            }
          | undefined;
        if (p?.tabsByWorkspace) {
          for (const [wsId, tabs] of Object.entries(p.tabsByWorkspace)) {
            p.tabsByWorkspace[wsId] = tabsNeedNormalize(tabs);
          }
        }
        if (fromVersion < 5 && p?.tabsByWorkspace) {
          for (const wsId of Object.keys(p.tabsByWorkspace)) {
            if (p.layoutByWorkspace) {
              p.layoutByWorkspace[wsId] = null;
            }
          }
        }
        if (p?.layoutByWorkspace) {
          const cleaned: Record<string, SerializedDockview | null> = {};
          for (const [wsId, layout] of Object.entries(p.layoutByWorkspace)) {
            const cleanedTabs = tabsNeedNormalize(p.tabsByWorkspace?.[wsId]);
            if (p.tabsByWorkspace) {
              p.tabsByWorkspace[wsId] = cleanedTabs;
            }
            const tabIds = cleanedTabs.map((t) => t.id);
            if (isLayoutUsable(layout)) {
              const viewsHaveAll = tabIds.every((id) => collectPanelIds(layout).has(id));
              cleaned[wsId] = viewsHaveAll ? layout : null;
            } else {
              cleaned[wsId] = null;
            }
          }
          return { ...p, layoutByWorkspace: cleaned } as typeof p;
        }
        return p as typeof p;
      },
    },
  ),
);

export function buildDefaultWorkspaceLayout(
  _workspace: WorkspaceInfo,
  tabs: WorkspaceDockTab[],
  activeTabId: string,
): SerializedDockview {
  const tabIds = tabs.map((tab) => tab.id);
  return (
    mergePanelsIntoLayout(null, tabIds, activeTabId) ??
    createDefaultLayout(tabIds, activeTabId)
  );
}

export function workspaceLayoutHasPanel(
  layout: SerializedDockview | null,
  panelId: string,
): boolean {
  if (!layout) return false;
  return collectPanelIds(layout).has(panelId);
}
