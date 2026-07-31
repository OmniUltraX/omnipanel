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
  type FileDockOpenMode,
  type FilesWorkspaceSessionSnapshot,
  sanitizeFilesWorkspaceSession,
} from "../modules/files/filesWorkspaceSession";
import { fileConnPanelId } from "../modules/files/filesWorkspacePanels";
import { createIndexedDBStorage } from "../lib/indexedDbStorage";

const STORAGE_KEY = "omnipanel.filesWorkspace.v1";
const LEGACY_DOCK_LAYOUT_KEY = "omnipanel.filesDockLayout.v3";

interface FilesWorkspaceSessionState extends FilesWorkspaceSessionSnapshot {
  setSavedLayout: (layout: SerializedDockview | null) => void;
  setActivePanelId: (panelId: string | null) => void;
  openConnection: (connId: string, mode?: FileDockOpenMode) => void;
  promotePreview: (connId: string) => void;
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
      openConnection: (connId, mode = "permanent") =>
        set((state) => {
          const alreadyOpen = state.openConnIds.includes(connId);
          const isPermanent = alreadyOpen && state.previewConnId !== connId;
          const withoutWorkspaceOnly = state.workspaceOnlyConnIds.filter((id) => id !== connId);

          if (mode === "preview") {
            if (isPermanent) {
              return {
                activePanelId: fileConnPanelId(connId),
                workspaceOnlyConnIds: withoutWorkspaceOnly,
              };
            }

            let openConnIds = [...state.openConnIds];
            let savedLayout = state.savedLayout;
            if (state.previewConnId && state.previewConnId !== connId) {
              const oldPreview = state.previewConnId;
              openConnIds = openConnIds.filter((id) => id !== oldPreview);
              savedLayout = removeFileTabFromLayout(savedLayout, fileConnPanelId(oldPreview));
            }
            if (!openConnIds.includes(connId)) {
              openConnIds = [...openConnIds, connId];
            }
            return {
              openConnIds,
              previewConnId: connId,
              activePanelId: fileConnPanelId(connId),
              savedLayout,
              workspaceOnlyConnIds: withoutWorkspaceOnly,
            };
          }

          const openConnIds = alreadyOpen
            ? state.openConnIds
            : [...state.openConnIds, connId];
          return {
            openConnIds,
            previewConnId: state.previewConnId === connId ? null : state.previewConnId,
            activePanelId: fileConnPanelId(connId),
            workspaceOnlyConnIds: withoutWorkspaceOnly,
          };
        }),
      promotePreview: (connId) =>
        set((state) => ({
          previewConnId: state.previewConnId === connId ? null : state.previewConnId,
        })),
      closeConnection: (connId) => {
        const tabId = fileConnPanelId(connId);
        const state = get();
        const openConnIds = state.openConnIds.filter((id) => id !== connId);
        set({
          openConnIds,
          previewConnId: state.previewConnId === connId ? null : state.previewConnId,
          activePanelId: pickNextActivePanelId(state.openConnIds, connId, state.activePanelId),
          savedLayout: removeFileTabFromLayout(state.savedLayout, tabId),
          workspaceOnlyConnIds: state.workspaceOnlyConnIds.filter((id) => id !== connId),
        });
      },
      setConnectionWorkspaceOnly: (connId, workspaceOnly) =>
        set((state) => {
          const next = new Set(state.workspaceOnlyConnIds);
          if (workspaceOnly) next.add(connId);
          else next.delete(connId);
          return {
            workspaceOnlyConnIds: [...next],
            // 拖出工作区视为钉住
            previewConnId:
              workspaceOnly && state.previewConnId === connId ? null : state.previewConnId,
          };
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
        let previewConnId = state.previewConnId;
        if (previewConnId && !allowed.has(previewConnId)) {
          previewConnId = null;
        } else if (previewConnId && !openConnIds.includes(previewConnId)) {
          previewConnId = null;
        }
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
          && previewConnId === state.previewConnId
          && activePanelId === state.activePanelId
          && Object.keys(panelStates).length === Object.keys(state.panelStates).length
        ) {
          return;
        }
        set({ openConnIds, activePanelId, previewConnId, panelStates, workspaceOnlyConnIds });
      },
      reset: () => set({ ...EMPTY_SESSION }),
    }),
    {
      name: STORAGE_KEY,
      version: 2,
      storage: createJSONStorage(createIndexedDBStorage),
      partialize: (state) => ({
        openConnIds: state.openConnIds,
        activePanelId: state.activePanelId,
        previewConnId: state.previewConnId,
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
              previewConnId: null,
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
