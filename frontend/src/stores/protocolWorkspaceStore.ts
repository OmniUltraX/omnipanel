import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { SerializedDockview } from "dockview-core";
import type { ProtocolTabKey } from "../lib/protocolLabConfig";
import { removePanelFromLayout } from "../components/dock/dockViewLayout";
import { patchDockTabPreviewMeta } from "../components/dock/dockTabLiveMeta";
import { createIndexedDBStorage } from "../lib/indexedDbStorage";

export type ProtocolDockOpenMode = "preview" | "permanent";

export interface ProtocolWorkspaceTab {
  id: string;
  protocol: ProtocolTabKey;
  label: string;
  /** HTTP 等为已持久化资源 id；MQTT 等待定协议可为 null */
  resourceId: string | null;
  /** 预览 Tab：单击打开，可被其他预览替换；双击升格为常驻 */
  preview?: boolean;
}

export interface OpenProtocolSessionInput {
  protocol: ProtocolTabKey;
  label?: string;
  resourceId?: string | null;
  /** 默认 permanent（新建请求 / 显式打开常驻） */
  mode?: ProtocolDockOpenMode;
}

interface ProtocolWorkspaceState {
  tabs: ProtocolWorkspaceTab[];
  activeTabId: string | null;
  savedLayout: SerializedDockview | null;
  openSessionTab: (input: OpenProtocolSessionInput) => string;
  promotePreviewTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTabId: (tabId: string | null) => void;
  updateTabLabel: (tabId: string, label: string) => void;
  /** 将草稿 Tab 绑定到已持久化资源（如 HTTP createRequest 完成后） */
  bindTabResource: (tabId: string, resourceId: string, label?: string) => void;
  setSavedLayout: (layout: SerializedDockview | null) => void;
  reset: () => void;
}

function createProtocolTabId(protocol: ProtocolTabKey): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : String(Date.now());
  return `protocol-${protocol}-${suffix}`;
}

function pickNextActiveTabId(
  tabs: ProtocolWorkspaceTab[],
  closingTabId: string,
  currentActive: string | null,
): string | null {
  if (currentActive !== closingTabId) {
    return currentActive;
  }
  const remaining = tabs.filter((tab) => tab.id !== closingTabId);
  return remaining[remaining.length - 1]?.id ?? null;
}

function findTabByResource(
  tabs: ProtocolWorkspaceTab[],
  protocol: ProtocolTabKey,
  resourceId: string,
): ProtocolWorkspaceTab | undefined {
  return tabs.find((tab) => tab.protocol === protocol && tab.resourceId === resourceId);
}

function findPreviewTab(tabs: ProtocolWorkspaceTab[]): ProtocolWorkspaceTab | undefined {
  return tabs.find((tab) => tab.preview);
}

const EMPTY_STATE = {
  tabs: [] as ProtocolWorkspaceTab[],
  activeTabId: null as string | null,
  savedLayout: null as SerializedDockview | null,
};

export const useProtocolWorkspaceStore = create<ProtocolWorkspaceState>()(
  persist(
    (set, get) => ({
      ...EMPTY_STATE,
      openSessionTab: (input) => {
        const mode: ProtocolDockOpenMode = input.mode ?? "permanent";
        const resourceId = input.resourceId ?? null;
        const label = input.label?.trim() || input.protocol;
        const { tabs } = get();

        if (resourceId) {
          const existing = findTabByResource(tabs, input.protocol, resourceId);
          if (existing) {
            if (mode === "permanent" && existing.preview) {
              get().promotePreviewTab(existing.id);
            }
            set({ activeTabId: existing.id });
            return existing.id;
          }
        }

        if (mode === "preview") {
          const previewTab = findPreviewTab(tabs);
          if (previewTab) {
            // 同一预览槽位替换内容，避免堆积临时 Tab
            patchDockTabPreviewMeta(previewTab.id, true);
            set((state) => ({
              tabs: state.tabs.map((tab) =>
                tab.id === previewTab.id
                  ? {
                      ...tab,
                      protocol: input.protocol,
                      label,
                      resourceId,
                      preview: true,
                    }
                  : tab,
              ),
              activeTabId: previewTab.id,
            }));
            return previewTab.id;
          }

          const tabId = createProtocolTabId(input.protocol);
          patchDockTabPreviewMeta(tabId, true);
          const tab: ProtocolWorkspaceTab = {
            id: tabId,
            protocol: input.protocol,
            label,
            resourceId,
            preview: true,
          };
          set((state) => ({
            tabs: [...state.tabs, tab],
            activeTabId: tab.id,
          }));
          return tab.id;
        }

        // permanent：若存在同资源预览，升格；否则新建常驻
        if (resourceId) {
          const matchingPreview = tabs.find(
            (tab) =>
              tab.preview &&
              tab.protocol === input.protocol &&
              tab.resourceId === resourceId,
          );
          if (matchingPreview) {
            get().promotePreviewTab(matchingPreview.id);
            set({ activeTabId: matchingPreview.id });
            return matchingPreview.id;
          }
        }

        const tab: ProtocolWorkspaceTab = {
          id: createProtocolTabId(input.protocol),
          protocol: input.protocol,
          label,
          resourceId,
        };
        set((state) => ({
          tabs: [...state.tabs, tab],
          activeTabId: tab.id,
        }));
        return tab.id;
      },
      promotePreviewTab: (tabId) => {
        const tab = get().tabs.find((item) => item.id === tabId);
        if (!tab?.preview) return;
        patchDockTabPreviewMeta(tabId, false);
        set((state) => ({
          tabs: state.tabs.map((item) =>
            item.id === tabId ? { ...item, preview: undefined } : item,
          ),
        }));
      },
      closeTab: (tabId) => {
        const state = get();
        const tabs = state.tabs.filter((tab) => tab.id !== tabId);
        set({
          tabs,
          activeTabId: pickNextActiveTabId(state.tabs, tabId, state.activeTabId),
          savedLayout: removePanelFromLayout(state.savedLayout, tabId),
        });
      },
      setActiveTabId: (activeTabId) => set({ activeTabId }),
      updateTabLabel: (tabId, label) => {
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id === tabId ? { ...tab, label: label.trim() || tab.label } : tab,
          ),
        }));
      },
      bindTabResource: (tabId, resourceId, label) => {
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id === tabId
              ? {
                  ...tab,
                  resourceId,
                  label: label?.trim() || tab.label,
                }
              : tab,
          ),
        }));
      },
      setSavedLayout: (savedLayout) => set({ savedLayout }),
      reset: () => set({ ...EMPTY_STATE }),
    }),
    {
      name: "omnipanel-protocol-workspace.v1",
      storage: createJSONStorage(createIndexedDBStorage),
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        savedLayout: state.savedLayout,
      }),
      migrate: (persisted, _version) => {
        const state = persisted as Partial<ProtocolWorkspaceState> | undefined;
        if (!state?.tabs) return persisted;
        return {
          ...state,
          tabs: state.tabs.map((tab) => ({
            ...tab,
            label: (tab as ProtocolWorkspaceTab).label ?? tab.protocol,
            resourceId: (tab as ProtocolWorkspaceTab).resourceId ?? null,
            preview: (tab as ProtocolWorkspaceTab).preview ? true : undefined,
          })),
        };
      },
      version: 1,
    },
  ),
);
