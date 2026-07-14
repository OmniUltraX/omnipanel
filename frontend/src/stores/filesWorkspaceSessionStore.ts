import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { SerializedDockview } from "dockview-core";
import {
  collectPanelIds,
  isLayoutUsable,
  removePanelFromLayout,
} from "../components/dock/dockViewLayout";
import {
  type FileConnectionPanelSnapshot,
  type FilesWorkspaceSessionSnapshot,
  sanitizeFilesWorkspaceSession,
} from "../modules/files/filesWorkspaceSession";
import { fileConnPanelId } from "../modules/files/filesWorkspacePanels";

const STORAGE_KEY = "omnipanel.filesWorkspace.v1";
const LEGACY_DOCK_LAYOUT_KEY = "omnipanel.filesDockLayout.v3";

interface FilesWorkspaceSessionState extends FilesWorkspaceSessionSnapshot {
  setSavedLayout: (layout: SerializedDockview | null) => void;
  setActivePanelId: (panelId: string | null) => void;
  openConnection: (connId: string) => void;
  closeConnection: (connId: string) => void;
  setPanelState: (connId: string, snapshot: FileConnectionPanelSnapshot) => void;
  pruneMissingConnections: (validConnIds: string[]) => void;
  setConnectionWorkspaceOnly: (connId: string, workspaceOnly: boolean) => void;
  reset: () => void;
}

const EMPTY_SESSION = sanitizeFilesWorkspaceSession(null);

function pickNextActivePanelId(
  openConnIds: string[],
  closingConnId: string,
  currentActive: string | null,
): string | null {
  const closingPanelId = fileConnPanelId(closingConnId);
  if (currentActive !== closingPanelId) return currentActive;
  const remaining = openConnIds.filter((id) => id !== closingConnId);
  return remaining.length > 0 ? fileConnPanelId(remaining[remaining.length - 1]!) : null;
}

/** 关闭连接 tab 时从 dockview 布局中移除 */
export function removeFileTabFromLayout(
  savedLayout: SerializedDockview | null,
  tabId: string,
): SerializedDockview | null {
  const next = removePanelFromLayout(savedLayout, tabId);
  if (next && collectPanelIds(next).size === 0) return null;
  return next;
}

function readLegacyDockLayout(): SerializedDockview | null {
  try {
    const raw = localStorage.getItem(LEGACY_DOCK_LAYOUT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { savedLayout?: SerializedDockview | null } };
    const layout = parsed?.state?.savedLayout ?? null;
    return isLayoutUsable(layout) ? layout : null;
  } catch {
    return null;
  }
}

export const useFilesWorkspaceSessionStore = create<FilesWorkspaceSessionState>()(
  persist(
    (set, get) => ({
      ...EMPTY_SESSION,
      setSavedLayout: (savedLayout) => set({ savedLayout }),
      setActivePanelId: (activePanelId) => set({ activePanelId }),
      openConnection: (connId) =>
        set((state) => ({
          openConnIds: state.openConnIds.includes(connId)
            ? state.openConnIds
            : [...state.openConnIds, connId],
          activePanelId: fileConnPanelId(connId),
          workspaceOnlyConnIds: state.workspaceOnlyConnIds.filter((id) => id !== connId),
        })),
      closeConnection: (connId) => {
        const tabId = fileConnPanelId(connId);
        const state = get();
        const openConnIds = state.openConnIds.filter((id) => id !== connId);
        set({
          openConnIds,
          activePanelId: pickNextActivePanelId(state.openConnIds, connId, state.activePanelId),
          savedLayout: removeFileTabFromLayout(state.savedLayout, tabId),
          workspaceOnlyConnIds: state.workspaceOnlyConnIds.filter((id) => id !== connId),
        });
      },
      setConnectionWorkspaceOnly: (connId, workspaceOnly) =>
        set((state) => {
          const set = new Set(state.workspaceOnlyConnIds);
          if (workspaceOnly) set.add(connId);
          else set.delete(connId);
          return { workspaceOnlyConnIds: [...set] };
        }),
      setPanelState: (connId, snapshot) =>
        set((state) => ({
          panelStates: { ...state.panelStates, [connId]: snapshot },
        })),
      pruneMissingConnections: (validConnIds) => {
        const allowed = new Set(validConnIds);
        const state = get();
        const openConnIds = state.openConnIds.filter((id) => allowed.has(id));
        const workspaceOnlyConnIds = state.workspaceOnlyConnIds.filter((id) => allowed.has(id));
        let activePanelId = state.activePanelId;
        if (activePanelId) {
          const activeConnId = activePanelId.replace(/^fm-conn:/, "");
          if (!allowed.has(activeConnId)) {
            activePanelId = openConnIds.length > 0
              ? fileConnPanelId(openConnIds[openConnIds.length - 1]!)
              : null;
          }
        }
        const panelStates = Object.fromEntries(
          Object.entries(state.panelStates).filter(([connId]) => allowed.has(connId)),
        );
        if (
          openConnIds.length === state.openConnIds.length
          && workspaceOnlyConnIds.length === state.workspaceOnlyConnIds.length
          && activePanelId === state.activePanelId
          && Object.keys(panelStates).length === Object.keys(state.panelStates).length
        ) {
          return;
        }
        set({ openConnIds, activePanelId, panelStates, workspaceOnlyConnIds });
      },
      reset: () => set({ ...EMPTY_SESSION }),
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        openConnIds: state.openConnIds,
        activePanelId: state.activePanelId,
        savedLayout: state.savedLayout,
        panelStates: state.panelStates,
        workspaceOnlyConnIds: state.workspaceOnlyConnIds,
      }),
      migrate: (persistedState, fromVersion) => {
        if (!persistedState || fromVersion < 1) {
          const legacyLayout = readLegacyDockLayout();
          if (legacyLayout) {
            return sanitizeFilesWorkspaceSession({
              openConnIds: [],
              activePanelId: null,
              savedLayout: legacyLayout,
              panelStates: {},
            });
          }
        }
        return sanitizeFilesWorkspaceSession(persistedState);
      },
    },
  ),
);

