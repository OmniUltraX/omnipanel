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
import type { WorkspaceInfo } from "./workspaceStore";

export type WorkspaceDockTabKind = "welcome" | "mirrored";

export interface WorkspaceDockTab {
  id: string;
  label: string;
  kind: WorkspaceDockTabKind;
  /** 面板类型：同源模块面板共享类型，用于 tab group 折叠 */
  panelType?: string;
  /** 来源 dock 实例 scope（如 terminal / database） */
  originScope?: string;
  /** 来源模块中的原始 panel / tab id */
  originPanelId?: string;
  closable?: boolean;
}

/** 解析工作区 dock tab 的面板类型 */
export function resolveWorkspaceDockPanelType(tab: WorkspaceDockTab): string {
  if (tab.panelType) return tab.panelType;
  if (tab.kind === "welcome") return "welcome";
  if (tab.originScope) return tab.originScope;
  return "unknown";
}

export function welcomeTabId(workspaceId: string): string {
  return `welcome:${workspaceId}`;
}

export function createWelcomeTab(workspace: WorkspaceInfo): WorkspaceDockTab {
  return {
    id: welcomeTabId(workspace.id),
    label: workspace.name,
    kind: "welcome",
    panelType: "welcome",
    closable: true,
  };
}

function ensureWorkspaceTabs(
  workspace: WorkspaceInfo,
  tabs: WorkspaceDockTab[] | undefined,
): WorkspaceDockTab[] {
  const list = tabs ? [...tabs] : [];
  if (list.length === 0) {
    list.push(createWelcomeTab(workspace));
  }
  return list.map((tab) =>
    tab.kind === "welcome" ? { ...tab, closable: true } : tab,
  );
}

/** 组件侧派生 tabs 时使用；勿放入 zustand selector。 */
export function resolveWorkspaceTabs(
  workspace: WorkspaceInfo,
  tabs: WorkspaceDockTab[] | undefined,
): WorkspaceDockTab[] {
  const list = tabs ? [...tabs] : [];
  return list.map((tab) =>
    tab.kind === "welcome" ? { ...tab, closable: true } : tab,
  );
}

export function resolveWorkspaceActiveTabId(
  workspace: WorkspaceInfo,
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
  /** 已被拖入底部工作区的来源 panel id，按 scope 分组 */
  dockedOriginByScope: Record<string, string[]>;

  ensureWelcomeTab: (workspaceId: string, workspace: WorkspaceInfo) => void;
  setLayout: (workspaceId: string, layout: SerializedDockview | null) => void;
  setActiveTabId: (workspaceId: string, tabId: string) => void;
  addMirroredTab: (
    workspaceId: string,
    workspace: WorkspaceInfo,
    tab: Omit<WorkspaceDockTab, "kind"> & { kind?: "mirrored" },
  ) => WorkspaceDockTab;
  removeTab: (workspaceId: string, workspace: WorkspaceInfo, tabId: string) => void;
  isOriginDocked: (scope: string, originPanelId: string) => boolean;
  /** 删除工作区时清理底部 dock 持久化数据 */
  removeWorkspaceData: (workspaceId: string) => void;
}

export const useWorkspaceBottomDockStore = create<WorkspaceBottomDockState>()(
  persist(
    (set, get) => ({
      tabsByWorkspace: {},
      layoutByWorkspace: {},
      activeTabByWorkspace: {},
      dockedOriginByScope: {},

      ensureWelcomeTab: (workspaceId, workspace) => {
        const welcomeId = welcomeTabId(workspaceId);
        const existing = get().tabsByWorkspace[workspaceId];
        if (existing !== undefined) return;
        set((state) => ({
          tabsByWorkspace: {
            ...state.tabsByWorkspace,
            [workspaceId]: ensureWorkspaceTabs(workspace, undefined),
          },
          activeTabByWorkspace: {
            ...state.activeTabByWorkspace,
            [workspaceId]: welcomeId,
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

      addMirroredTab: (workspaceId, workspace, tab) => {
        const nextTab: WorkspaceDockTab = {
          ...tab,
          kind: "mirrored",
          panelType: tab.panelType ?? tab.originScope ?? "unknown",
          closable: tab.closable !== false,
        };
        set((state) => {
          const current = state.tabsByWorkspace[workspaceId] ?? [];
          const tabs = current.some((item) => item.id === nextTab.id)
            ? current.map((item) => (item.id === nextTab.id ? nextTab : item))
            : [...current, nextTab];
          const dockedOriginByScope = { ...state.dockedOriginByScope };
          if (nextTab.originScope && nextTab.originPanelId) {
            const prev = new Set(dockedOriginByScope[nextTab.originScope] ?? []);
            prev.add(nextTab.originPanelId);
            dockedOriginByScope[nextTab.originScope] = [...prev];
          }
          return {
            tabsByWorkspace: { ...state.tabsByWorkspace, [workspaceId]: tabs },
            activeTabByWorkspace: {
              ...state.activeTabByWorkspace,
              [workspaceId]: nextTab.id,
            },
            dockedOriginByScope,
          };
        });
        return nextTab;
      },

      removeTab: (workspaceId, workspace, tabId) => {
        set((state) => {
          const current = state.tabsByWorkspace[workspaceId] ?? [];
          const removed = current.find((tab) => tab.id === tabId);
          if (!removed) return state;
          const tabs = current.filter((tab) => tab.id !== tabId);
          const dockedOriginByScope = { ...state.dockedOriginByScope };
          if (removed.originScope && removed.originPanelId) {
            const list = (dockedOriginByScope[removed.originScope] ?? []).filter(
              (id) => id !== removed.originPanelId,
            );
            if (list.length === 0) {
              delete dockedOriginByScope[removed.originScope];
            } else {
              dockedOriginByScope[removed.originScope] = list;
            }
          }
          const prevLayout = state.layoutByWorkspace[workspaceId] ?? null;
          const nextLayout = removePanelFromLayout(prevLayout, tabId);
          const active = state.activeTabByWorkspace[workspaceId];
          const nextActive =
            active === tabId ? (tabs[0]?.id ?? "") : (active ?? tabs[0]?.id ?? "");
          return {
            tabsByWorkspace: { ...state.tabsByWorkspace, [workspaceId]: tabs },
            layoutByWorkspace: {
              ...state.layoutByWorkspace,
              [workspaceId]: nextLayout,
            },
            activeTabByWorkspace: {
              ...state.activeTabByWorkspace,
              [workspaceId]: nextActive,
            },
            dockedOriginByScope,
          };
        });
      },

      isOriginDocked: (scope, originPanelId) => {
        const list = get().dockedOriginByScope[scope] ?? [];
        return list.includes(originPanelId);
      },

      removeWorkspaceData: (workspaceId) => {
        set((state) => {
          const tabs = state.tabsByWorkspace[workspaceId] ?? [];
          const dockedOriginByScope = { ...state.dockedOriginByScope };
          for (const tab of tabs) {
            if (!tab.originScope || !tab.originPanelId) continue;
            const list = (dockedOriginByScope[tab.originScope] ?? []).filter(
              (id) => id !== tab.originPanelId,
            );
            if (list.length === 0) {
              delete dockedOriginByScope[tab.originScope];
            } else {
              dockedOriginByScope[tab.originScope] = list;
            }
          }
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
            dockedOriginByScope,
          };
        });
      },
    }),
    {
      name: "omnipanel.workspace-bottom-dock.v2",
      version: 2,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        tabsByWorkspace: state.tabsByWorkspace,
        layoutByWorkspace: state.layoutByWorkspace,
        activeTabByWorkspace: state.activeTabByWorkspace,
        dockedOriginByScope: state.dockedOriginByScope,
      }),
      migrate: (persistedState, _fromVersion) => {
        // v1 期间可能写入了 panels↔views 漂移的 layout；逐个工作区校验。
        const p = persistedState as
          | {
              layoutByWorkspace?: Record<string, SerializedDockview | null>;
              tabsByWorkspace?: Record<string, WorkspaceDockTab[]>;
            }
          | undefined;
        if (p?.layoutByWorkspace) {
          const cleaned: Record<string, SerializedDockview | null> = {};
          for (const [wsId, layout] of Object.entries(p.layoutByWorkspace)) {
            const tabIds = (p.tabsByWorkspace?.[wsId] ?? []).map((t) => t.id);
            // 已有 layout 且指向当前 tabs 的 panel：保留；否则丢弃。
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
  workspace: WorkspaceInfo,
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
