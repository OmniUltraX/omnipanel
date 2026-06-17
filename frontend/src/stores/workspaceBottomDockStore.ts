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

export type WorkspaceDockTabKind = "mirrored" | "payload";

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
  /** 序列化快照（复制/移动到工作区） */
  payload?: WorkspaceTabSnapshot;
  closable?: boolean;
}

/** 解析工作区 dock tab 的面板类型 */
export function resolveWorkspaceDockPanelType(tab: WorkspaceDockTab): string {
  if (tab.panelType) return tab.panelType;
  if (tab.originScope) return tab.originScope;
  return "unknown";
}

function ensureWorkspaceTabs(
  _workspace: WorkspaceInfo,
  tabs: WorkspaceDockTab[] | undefined,
): WorkspaceDockTab[] {
  const legacyTabs = (tabs ?? []) as Array<WorkspaceDockTab | { kind: "welcome" }>;
  return legacyTabs.filter((tab) => tab.kind !== "welcome") as WorkspaceDockTab[];
}

/** 组件侧派生 tabs 时使用；勿放入 zustand selector。 */
export function resolveWorkspaceTabs(
  _workspace: WorkspaceInfo,
  tabs: WorkspaceDockTab[] | undefined,
): WorkspaceDockTab[] {
  const legacyTabs = (tabs ?? []) as Array<WorkspaceDockTab | { kind: "welcome" }>;
  return legacyTabs.filter((tab) => tab.kind !== "welcome") as WorkspaceDockTab[];
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
  /** 已被拖入底部工作区的来源 panel id，按 scope 分组 */
  dockedOriginByScope: Record<string, string[]>;

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
  removeDockedOrigin: (scope: string, originPanelId: string) => void;
  isOriginDocked: (scope: string, originPanelId: string) => boolean;
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
      dockedOriginByScope: {},

      ensureWorkspaceData: (workspaceId, workspace) => {
        const existing = get().tabsByWorkspace[workspaceId];
        if (existing !== undefined) {
          const cleaned = ensureWorkspaceTabs(workspace, existing);
          if (cleaned.length === existing.length) return;
          set((state) => ({
            tabsByWorkspace: {
              ...state.tabsByWorkspace,
              [workspaceId]: cleaned,
            },
            layoutByWorkspace: {
              ...state.layoutByWorkspace,
              [workspaceId]: null,
            },
            activeTabByWorkspace: {
              ...state.activeTabByWorkspace,
              [workspaceId]: cleaned[0]?.id ?? "",
            },
          }));
          return;
        }
        set((state) => ({
          tabsByWorkspace: {
            ...state.tabsByWorkspace,
            [workspaceId]: [],
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
          panelType: tab.panelType ?? tab.originScope ?? "unknown",
          closable: tab.closable !== false,
        };
        set((state) => {
          const current = ensureWorkspaceTabs(_workspace, state.tabsByWorkspace[workspaceId]);
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

      addPayloadTab: (workspaceId, _workspace, tab) => {
        const nextTab: WorkspaceDockTab = {
          ...tab,
          kind: "payload",
          panelType: tab.panelType ?? tab.payload.module,
          closable: tab.closable !== false,
        };
        set((state) => {
          const current = ensureWorkspaceTabs(_workspace, state.tabsByWorkspace[workspaceId]);
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

      removeTab: (workspaceId, _workspace, tabId) => {
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

      removeDockedOrigin: (scope, originPanelId) => {
        set((state) => {
          const list = (state.dockedOriginByScope[scope] ?? []).filter(
            (id) => id !== originPanelId,
          );
          const dockedOriginByScope = { ...state.dockedOriginByScope };
          if (list.length === 0) {
            delete dockedOriginByScope[scope];
          } else {
            dockedOriginByScope[scope] = list;
          }
          return { dockedOriginByScope };
        });
      },

      isOriginDocked: (scope, originPanelId) => {
        const list = get().dockedOriginByScope[scope] ?? [];
        return list.includes(originPanelId);
      },

      removeWorkspaceData: (workspaceId) => {
        set((state) => {
          const tabs = ensureWorkspaceTabs({ id: workspaceId, name: "", description: "" }, state.tabsByWorkspace[workspaceId]);
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

      resetAll: () =>
        set({
          tabsByWorkspace: {},
          layoutByWorkspace: {},
          activeTabByWorkspace: {},
          dockedOriginByScope: {},
        }),
    }),
    {
      name: "omnipanel.workspace-bottom-dock.v3",
      version: 4,
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
        if (p?.tabsByWorkspace) {
          for (const [wsId, tabs] of Object.entries(p.tabsByWorkspace)) {
            p.tabsByWorkspace[wsId] = ensureWorkspaceTabs(
              { id: wsId, name: "", description: "" },
              tabs,
            );
          }
        }
        if (p?.layoutByWorkspace) {
          const cleaned: Record<string, SerializedDockview | null> = {};
          for (const [wsId, layout] of Object.entries(p.layoutByWorkspace)) {
            const cleanedTabs = ensureWorkspaceTabs(
              { id: wsId, name: "", description: "" },
              p.tabsByWorkspace?.[wsId],
            );
            if (p.tabsByWorkspace) {
              p.tabsByWorkspace[wsId] = cleanedTabs;
            }
            const tabIds = cleanedTabs.map((t) => t.id);
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
