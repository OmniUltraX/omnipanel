import type { SerializedDockview } from "dockview-core";
import { isLayoutUsable } from "../../components/dock/dockViewLayout";
import { fileConnPanelId } from "./filesWorkspacePanels";

export type FilePanelViewMode = "list" | "grid";

export interface FileConnectionPanelSnapshot {
  viewMode: FilePanelViewMode;
  detailVisible: boolean;
  currentPath: string;
  history: string[];
  historyIndex: number;
}

export interface FilesWorkspaceSessionSnapshot {
  openConnIds: string[];
  activePanelId: string | null;
  savedLayout: SerializedDockview | null;
  panelStates: Record<string, FileConnectionPanelSnapshot>;
  /** 已移动到工作区、主面板需隐藏的连接 id */
  workspaceOnlyConnIds: string[];
}

export function createDefaultPanelState(): FileConnectionPanelSnapshot {
  return {
    viewMode: "list",
    detailVisible: true,
    currentPath: "",
    history: [],
    historyIndex: -1,
  };
}

function sanitizePanelState(raw: unknown): FileConnectionPanelSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<FileConnectionPanelSnapshot>;
  const viewMode = o.viewMode === "grid" ? "grid" : "list";
  const detailVisible = o.detailVisible !== false;
  const currentPath = typeof o.currentPath === "string" ? o.currentPath : "";
  const history = Array.isArray(o.history)
    ? o.history.filter((item): item is string => typeof item === "string")
    : [];
  const historyIndex = typeof o.historyIndex === "number" && Number.isFinite(o.historyIndex)
    ? Math.trunc(o.historyIndex)
    : history.length > 0
      ? history.length - 1
      : -1;
  return { viewMode, detailVisible, currentPath, history, historyIndex };
}

export function sanitizeFilesWorkspaceSession(
  raw: unknown,
): FilesWorkspaceSessionSnapshot {
  if (!raw || typeof raw !== "object") {
    return {
      openConnIds: [],
      activePanelId: null,
      savedLayout: null,
      panelStates: {},
      workspaceOnlyConnIds: [],
    };
  }
  const o = raw as Partial<FilesWorkspaceSessionSnapshot>;
  const openConnIds = Array.isArray(o.openConnIds)
    ? [...new Set(o.openConnIds.filter((id): id is string => typeof id === "string"))]
    : [];
  let activePanelId = typeof o.activePanelId === "string" ? o.activePanelId : null;
  if (activePanelId && !openConnIds.some((id) => fileConnPanelId(id) === activePanelId)) {
    activePanelId = openConnIds.length > 0 ? fileConnPanelId(openConnIds[openConnIds.length - 1]!) : null;
  }
  const savedLayout = isLayoutUsable(o.savedLayout ?? null) ? o.savedLayout! : null;
  const panelStates: Record<string, FileConnectionPanelSnapshot> = {};
  if (o.panelStates && typeof o.panelStates === "object") {
    for (const [connId, state] of Object.entries(o.panelStates)) {
      const sanitized = sanitizePanelState(state);
      if (sanitized) panelStates[connId] = sanitized;
    }
  }
  const workspaceOnlyConnIds = Array.isArray(o.workspaceOnlyConnIds)
    ? [...new Set(o.workspaceOnlyConnIds.filter((id): id is string => typeof id === "string"))]
    : [];
  return { openConnIds, activePanelId, savedLayout, panelStates, workspaceOnlyConnIds };
}
