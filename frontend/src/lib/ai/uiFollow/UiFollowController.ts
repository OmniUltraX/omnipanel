import { MODULE_PATHS } from "../../paths";
import { useDockerPanelDockStore } from "../../../stores/dockerPanelDockStore";
import { useFilesWorkspaceSessionStore } from "../../../stores/filesWorkspaceSessionStore";
import { useTerminalStore } from "../../../stores/terminalStore";
import { useTerminalUiStore } from "../../../modules/terminal/terminalUiStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { fileConnPanelId } from "../../../modules/files/filesWorkspacePanels";
import type { UiFollowIntent } from "./types";
import { isFollowAiActionsEnabled } from "./uiFollowStore";

type NavigateFn = (path: string) => void;

let navigateFn: NavigateFn | null = null;

/** 由 App 根组件注册 react-router navigate，供非 React 工具 handler 调用。 */
export function registerUiFollowNavigate(navigate: NavigateFn): () => void {
  navigateFn = navigate;
  return () => {
    if (navigateFn === navigate) navigateFn = null;
  };
}

function navigateTo(path: string): void {
  if (navigateFn) {
    navigateFn(path);
  }
}

/**
 * 执行跟随意图。Follow 关闭时 no-op。
 * 写操作确认不在此层处理。
 */
export function followAiIntent(intent: UiFollowIntent): void {
  if (!isFollowAiActionsEnabled()) return;

  switch (intent.type) {
    case "focusModule": {
      const path = MODULE_PATHS[intent.module];
      if (path) navigateTo(path);
      break;
    }
    case "openConnection": {
      if (intent.module === "docker") {
        navigateTo(MODULE_PATHS.docker);
        useDockerPanelDockStore.getState().selectConnection(intent.resourceId);
      } else if (intent.module === "files") {
        navigateTo(MODULE_PATHS.files);
        useFilesWorkspaceSessionStore.getState().openConnection(intent.resourceId);
      } else if (intent.module === "ssh" || intent.module === "database") {
        const path = MODULE_PATHS[intent.module];
        navigateTo(path);
        useWorkspaceStore.getState().selectResource(intent.resourceId, path);
      }
      break;
    }
    case "selectContainer": {
      navigateTo(MODULE_PATHS.docker);
      useDockerPanelDockStore
        .getState()
        .selectContainer(intent.connectionId, intent.containerId);
      break;
    }
    case "openSqlDraft": {
      navigateTo(MODULE_PATHS.database);
      useWorkspaceStore
        .getState()
        .selectResource(intent.connectionId, MODULE_PATHS.database);
      if (intent.sql?.trim()) {
        window.dispatchEvent(
          new CustomEvent("omnipanel:ai-open-sql-draft", {
            detail: {
              connectionId: intent.connectionId,
              database: intent.database ?? null,
              sql: intent.sql,
            },
          }),
        );
      }
      break;
    }
    case "revealTerminal": {
      navigateTo(MODULE_PATHS.terminal);
      useTerminalStore.getState().setActiveTab(intent.sessionId);
      if (intent.blockId) {
        useTerminalUiStore.getState().setExpandedAiBlock(intent.sessionId, intent.blockId);
      }
      break;
    }
    case "openFile": {
      navigateTo(MODULE_PATHS.files);
      const files = useFilesWorkspaceSessionStore.getState();
      files.openConnection(intent.connectionId);
      files.setActivePanelId(fileConnPanelId(intent.connectionId));
      const prev = files.panelStates[intent.connectionId];
      files.setPanelState(intent.connectionId, {
        viewMode: prev?.viewMode ?? "list",
        detailVisible: prev?.detailVisible ?? false,
        currentPath: intent.path,
        history: prev?.history ?? [intent.path],
        historyIndex: prev?.historyIndex ?? 0,
      });
      break;
    }
    case "switchWorkspace": {
      useWorkspaceStore.getState().switchWorkspace(intent.workspaceId);
      break;
    }
    default:
      break;
  }
}

/** 批量意图：顺序执行（通常先 focusModule 再选资源）。 */
export function followAiIntents(intents: UiFollowIntent[]): void {
  for (const intent of intents) {
    followAiIntent(intent);
  }
}
