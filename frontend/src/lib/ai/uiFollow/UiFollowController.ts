/**
 * Follow 意图控制器。
 *
 * 重构后的架构：
 * 1. 路由切换：所有 intent 先 navigate 到目标模块（确保面板挂载）
 * 2. Registry 分发：通过 followRegistry 向已挂载的面板分发 intent
 * 3. Pending 兜底：如果面板未挂载（无 handler 响应），入 pending 队列
 * 4. 面板挂载时通过 useUiFollowConsumer 自动消费 pending
 *
 * 对比旧方案：
 * - 旧：Controller 硬编码每个模块的 store 调用（6 个 if/else 分支）
 * - 新：Controller 只做 navigate + dispatch，面板自洽处理资源定位
 *
 * 兼容性：Terminal/Docker/Files 的直接 store 调用保留为「内置 handler」，
 * 因为这些模块的 store API 稳定且无需面板挂载即可调用。
 */
import { MODULE_PATHS } from "../../paths";
import { useDockerPanelDockStore } from "../../../stores/dockerPanelDockStore";
import { useFilesWorkspaceSessionStore } from "../../../stores/filesWorkspaceSessionStore";
import { useTerminalStore } from "../../../stores/terminalStore";
import { useTerminalUiStore } from "../../../modules/terminal/terminalUiStore";
import { useWorkspaceStore } from "../../../stores/workspaceStore";
import { fileConnPanelId } from "../../../modules/files/filesWorkspacePanels";
import { dispatchFollow } from "./followRegistry";
import { resolveIntentModule, type FollowModuleKey, type UiFollowIntent } from "./types";
import { usePendingFollowIntentsStore } from "./pendingFollowIntentsStore";
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

function navigateToModule(module: FollowModuleKey): void {
  const path = MODULE_PATHS[module];
  if (path) navigateTo(path);
}

/**
 * 内置 handler：Terminal/Docker/Files 的直接 store 调用。
 * 这些模块的 store API 稳定且无需面板挂载即可调用，
 * 保留为内置逻辑避免面板必须挂载才能 follow。
 */
function builtinHandle(intent: UiFollowIntent): boolean {
  switch (intent.type) {
    case "revealTerminal": {
      useTerminalStore.getState().setActiveTab(intent.sessionId);
      if (intent.blockId) {
        useTerminalUiStore.getState().setExpandedAiBlock(intent.sessionId, intent.blockId);
      }
      return true;
    }
    case "selectContainer": {
      useDockerPanelDockStore
        .getState()
        .selectContainer(intent.connectionId, intent.containerId);
      return true;
    }
    case "openConnection": {
      if (intent.module === "docker") {
        useDockerPanelDockStore.getState().selectConnection(intent.resourceId);
        return true;
      }
      if (intent.module === "files") {
        useFilesWorkspaceSessionStore.getState().openConnection(intent.resourceId);
        return true;
      }
      // ssh/database/server 走 registry（面板需要挂载才能处理）
      return false;
    }
    case "openFile": {
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
      return true;
    }
    case "switchWorkspace": {
      useWorkspaceStore.getState().switchWorkspace(intent.workspaceId);
      return true;
    }
    default:
      return false;
  }
}

/**
 * 执行跟随意图。Follow 关闭时 no-op。
 *
 * 流程：
 * 1. navigate 到目标模块（确保面板挂载）
 * 2. 先尝试内置 handler（Terminal/Docker/Files/Workspace）
 * 3. 再尝试 registry 分发到面板注册的 handler
 * 4. 都没处理 → 入 pending 队列，面板挂载时消费
 */
export function followAiIntent(intent: UiFollowIntent): void {
  if (!isFollowAiActionsEnabled()) return;

  // 1. 路由切换
  const module = resolveIntentModule(intent);
  if (module) {
    navigateToModule(module);
  } else if (intent.type === "switchWorkspace") {
    // switchWorkspace 不需要 navigate
  }

  // 2. 内置 handler（无需面板挂载的稳定 store 调用）
  if (builtinHandle(intent)) return;

  // 3. Registry 分发（面板注册的 handler）
  if (module) {
    const handled = dispatchFollow(module, intent);
    if (handled) return;

    // 4. 未挂载 → 入 pending 队列
    usePendingFollowIntentsStore.getState().enqueue(module, intent);
  }
}

/** 批量意图：顺序执行（通常先 focusModule 再选资源）。 */
export function followAiIntents(intents: UiFollowIntent[]): void {
  for (const intent of intents) {
    followAiIntent(intent);
  }
}
