import type { SerializedDockview } from "dockview-core";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createSafeLocalStorage } from "../lib/zustandPersistStorage";
import {
  isLayoutUsable,
  normalizeDockLayout,
  safeLayoutForFromJson,
} from "../components/dock/dockViewLayout";
import {
  findPreviewDockTab,
  findTabIdForAccount,
  findTabIdForResource,
  findTabIdForResources,
  makeCloudAccountTabId,
  makeCloudResourceTabId,
  makeCloudResourcesTabId,
  sanitizeCloudDockTabs,
  type CloudDockOpenMode,
  type CloudWorkspaceTab,
} from "../modules/cloud/cloudWorkspaceTabs";

interface CloudDockState {
  tabs: CloudWorkspaceTab[];
  activeTabId: string | null;
  dockLayout: SerializedDockview | null;
  selectAccount: (accountId: string, mode?: CloudDockOpenMode) => void;
  selectResources: (accountId: string, capability: string, mode?: CloudDockOpenMode) => void;
  selectResource: (
    accountId: string,
    capability: string,
    resourceId: string,
    regionId?: string,
    mode?: CloudDockOpenMode,
  ) => void;
  closeTab: (tabId: string) => void;
  setActiveTabId: (tabId: string | null) => void;
  setDockLayout: (layout: SerializedDockview | null) => void;
  removeAccountTabs: (accountId: string) => void;
}

function reconcileActiveTabId(tabs: CloudWorkspaceTab[], activeTabId: string | null): string | null {
  if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) return activeTabId;
  return tabs[tabs.length - 1]?.id ?? null;
}

function openOrFocus(
  state: CloudDockState,
  mode: CloudDockOpenMode,
  existingTabId: string | undefined,
  makeTab: (id: string, preview: boolean) => CloudWorkspaceTab,
): Pick<CloudDockState, "tabs" | "activeTabId"> {
  const previewTab = findPreviewDockTab(state.tabs);

  if (mode === "permanent") {
    if (existingTabId) {
      return {
        tabs: state.tabs.map((tab) => (tab.id === existingTabId ? { ...tab, preview: false } : tab)),
        activeTabId: existingTabId,
      };
    }
    if (previewTab) {
      return {
        tabs: state.tabs.map((tab) =>
          tab.id === previewTab.id ? makeTab(previewTab.id, false) : tab,
        ),
        activeTabId: previewTab.id,
      };
    }
    const id = makeTab("", false).id;
    return { tabs: [...state.tabs, makeTab(id, false)], activeTabId: id };
  }

  if (existingTabId) {
    const existing = state.tabs.find((tab) => tab.id === existingTabId);
    if (existing && !existing.preview) {
      return { tabs: state.tabs, activeTabId: existingTabId };
    }
  }

  if (previewTab) {
    return {
      tabs: state.tabs.map((tab) =>
        tab.id === previewTab.id ? makeTab(previewTab.id, true) : tab,
      ),
      activeTabId: previewTab.id,
    };
  }

  if (existingTabId) {
    return { tabs: state.tabs, activeTabId: existingTabId };
  }

  const created = makeTab("", true);
  return { tabs: [...state.tabs, created], activeTabId: created.id };
}

export const useCloudDockStore = create<CloudDockState>()(
  persist(
    (set) => ({
      tabs: [],
      activeTabId: null,
      dockLayout: null,

      selectAccount: (accountId, mode = "preview") => {
        set((state) =>
          openOrFocus(state, mode, findTabIdForAccount(state.tabs, accountId), (id, preview) => ({
            id: id || makeCloudAccountTabId(accountId),
            kind: "account",
            accountId,
            preview,
          })),
        );
      },

      selectResources: (accountId, capability, mode = "preview") => {
        set((state) =>
          openOrFocus(
            state,
            mode,
            findTabIdForResources(state.tabs, accountId, capability),
            (id, preview) => ({
              id: id || makeCloudResourcesTabId(accountId, capability),
              kind: "resources",
              accountId,
              capability,
              preview,
            }),
          ),
        );
      },

      selectResource: (accountId, capability, resourceId, regionId = "", mode = "preview") => {
        set((state) =>
          openOrFocus(
            state,
            mode,
            findTabIdForResource(state.tabs, accountId, capability, resourceId),
            (id, preview) => ({
              id: id || makeCloudResourceTabId(accountId, capability, resourceId),
              kind: "resource",
              accountId,
              capability,
              resourceId,
              regionId,
              preview,
            }),
          ),
        );
      },

      closeTab: (tabId) => {
        set((state) => {
          const tabs = state.tabs.filter((tab) => tab.id !== tabId);
          return { tabs, activeTabId: reconcileActiveTabId(tabs, state.activeTabId) };
        });
      },

      setActiveTabId: (tabId) => set({ activeTabId: tabId }),
      setDockLayout: (layout) => {
        const next = normalizeDockLayout(layout);
        set({ dockLayout: next && isLayoutUsable(next) ? next : null });
      },

      removeAccountTabs: (accountId) => {
        set((state) => {
          const tabs = state.tabs.filter((tab) => tab.accountId !== accountId);
          return { tabs, activeTabId: reconcileActiveTabId(tabs, state.activeTabId) };
        });
      },
    }),
    {
      name: "omnipanel.cloud.dock",
      version: 3,
      storage: createJSONStorage(createSafeLocalStorage),
      migrate: (persisted) => {
        if (!persisted || typeof persisted !== "object") {
          return persisted as CloudDockState;
        }
        const state = persisted as CloudDockState;
        const tabs = sanitizeCloudDockTabs(state.tabs ?? []);
        const tabIds = tabs.map((tab) => tab.id);
        const activeId = reconcileActiveTabId(tabs, state.activeTabId ?? null) ?? tabIds[0] ?? "";
        const normalized = safeLayoutForFromJson(state.dockLayout ?? null, tabIds, activeId);
        const dockLayout = isLayoutUsable(normalized) ? normalized : null;
        return {
          ...state,
          tabs,
          dockLayout,
          activeTabId: reconcileActiveTabId(tabs, state.activeTabId ?? null),
        };
      },
      partialize: (state) => ({
        tabs: state.tabs,
        activeTabId: state.activeTabId,
        dockLayout: state.dockLayout,
      }),
    },
  ),
);
