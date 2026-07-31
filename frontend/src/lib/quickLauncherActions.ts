import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  listenQuickLauncherAction,
  syncTrayActiveToBackend,
  type QuickLauncherAction,
} from "./quickLauncher";
import { clearWindowHiddenToTray, getTrayHiddenLabels } from "./trayHiddenWindows";
import { focusMainWindow, goWorkspaceHome } from "./workspaceNavigation";
import { MODULE_PATHS, type ModuleKey } from "./paths";
import { navigateToPath, openLocalTerminalSession, openSshTerminalSession } from "./terminalSession";
import { useConnectionStore } from "../stores/connectionStore";
import { useTerminalLeftPanelStore } from "../modules/terminal/terminalLeftPanelStore";
import { followUiIntent } from "./ai/uiFollow";
import {
  listenModuleWindowShown,
  openModuleWindow,
  parseModuleWindowParams,
} from "./moduleWindow";

const DOCKER_ACTIVE_KEY = "omnipanel.docker.activeConnectionId";
const MODULE_QUICK_ACTION_EVENT = "omnipanel:module-quick-action";

async function wakeMainFromTray(): Promise<void> {
  for (const label of getTrayHiddenLabels()) {
    clearWindowHiddenToTray(label);
  }
  await syncTrayActiveToBackend(false);
  await focusMainWindow();
}

async function runCommand(id: string): Promise<void> {
  await wakeMainFromTray();

  switch (id) {
    case "workspace":
      goWorkspaceHome();
      return;
    case "focus-main":
      // 仅唤醒/聚焦主窗，不导航、不受 SOLO 影响
      return;
    case "terminal":
      navigateToPath(MODULE_PATHS.terminal);
      return;
    case "database":
      navigateToPath(MODULE_PATHS.database);
      return;
    case "ssh":
    case "new-ssh":
      useTerminalLeftPanelStore.getState().focusSsh();
      navigateToPath(MODULE_PATHS.terminal);
      return;
    case "docker":
      navigateToPath(MODULE_PATHS.docker);
      return;
    case "server":
      navigateToPath(MODULE_PATHS.server);
      return;
    case "protocol":
      navigateToPath(MODULE_PATHS.protocol);
      return;
    case "workflow":
      navigateToPath(MODULE_PATHS.workflow);
      return;
    case "knowledge":
      navigateToPath(MODULE_PATHS.knowledge);
      return;
    case "files":
      navigateToPath(MODULE_PATHS.files);
      return;
    case "tasks":
      navigateToPath(MODULE_PATHS.tasks);
      return;
    case "settings":
      void import("../stores/settingsUiStore").then(({ useSettingsUiStore }) =>
        useSettingsUiStore.getState().openSettings(),
      );
      return;
    case "new-terminal":
      navigateToPath(MODULE_PATHS.terminal);
      openLocalTerminalSession();
      return;
    case "open-ai":
    case "new-ai-conv":
      void import("../stores/aiStore").then(({ useAiStore }) => {
        const store = useAiStore.getState();
        if (id === "new-ai-conv") store.createConversation();
        store.openDrawer();
      });
      return;
    default:
      navigateToPath(MODULE_PATHS.terminal);
  }
}

/** 兼容旧 connection action（模块图标外的历史路径）。 */
async function runLegacyConnection(id: string): Promise<void> {
  const conn = useConnectionStore.getState().connections.find((c) => c.id === id);
  await wakeMainFromTray();
  if (!conn) return;

  if (conn.kind === "ssh") {
    openSshTerminalSession(conn.id);
    return;
  }
  if (conn.kind === "database") {
    followUiIntent({ type: "openConnection", module: "database", resourceId: conn.id });
    return;
  }
  if (conn.kind === "docker") {
    try {
      localStorage.setItem(DOCKER_ACTIVE_KEY, conn.id);
    } catch {
      /* ignore */
    }
    navigateToPath(MODULE_PATHS.docker);
    return;
  }
  if (conn.kind === "panel") {
    navigateToPath(MODULE_PATHS.server);
    return;
  }
  if (conn.kind === "file") {
    navigateToPath(MODULE_PATHS.files);
    return;
  }
  if (conn.kind === "protocol") {
    navigateToPath(MODULE_PATHS.protocol);
  }
}

/** 资源类动作对应的目标模块（SOLO 独立窗）。 */
export function moduleKeyForQuickLauncherAction(
  action: QuickLauncherAction,
): ModuleKey | null {
  switch (action.kind) {
    case "ssh-connection":
      return "terminal";
    case "db-connection":
    case "db-database":
    case "db-table":
      return "database";
    default:
      return null;
  }
}

/** 在当前 WebView 内执行资源打开（SSH / DB）。 */
export function applyQuickLauncherResourceAction(action: QuickLauncherAction): void {
  switch (action.kind) {
    case "ssh-connection":
      openSshTerminalSession(action.connectionId);
      return;
    case "db-connection":
      followUiIntent({
        type: "openConnection",
        module: "database",
        resourceId: action.connectionId,
      });
      return;
    case "db-database":
      followUiIntent({
        type: "selectDatabase",
        connectionId: action.connectionId,
        database: action.database,
      });
      return;
    case "db-table":
      followUiIntent({
        type: "selectTable",
        connectionId: action.connectionId,
        database: action.database,
        table: action.table,
      });
      return;
    default:
      break;
  }
}

/** 发给模块独立窗执行的快捷启动资源动作。 */
export async function emitModuleQuickLauncherAction(
  action: QuickLauncherAction,
): Promise<void> {
  await emit(MODULE_QUICK_ACTION_EVENT, action);
}

/**
 * SOLO：打开目标模块独立窗，再把资源动作广播给该窗执行。
 * 冷启动等 module-window-shown；热复用走超时兜底。
 * 面板未挂载时 follow 会入 pending，挂载后自动消费。
 */
export async function runQuickLauncherActionInSoloModule(
  action: QuickLauncherAction,
  moduleTitle: string,
): Promise<void> {
  const moduleKey = moduleKeyForQuickLauncherAction(action);
  if (!moduleKey) return;

  let delivered = false;
  const deliver = async () => {
    if (delivered) return;
    delivered = true;
    // 等独立窗 React 挂上 Panel / follow consumer
    await new Promise((resolve) => window.setTimeout(resolve, 60));
    await emitModuleQuickLauncherAction(action);
  };

  const unlistenShown = await listenModuleWindowShown((payload) => {
    if (payload.moduleKey !== moduleKey) return;
    void deliver().finally(() => {
      unlistenShown();
    });
  });

  try {
    await openModuleWindow(moduleKey, moduleTitle);
  } catch (e) {
    unlistenShown();
    throw e;
  }

  // 热复用时 shown 可能已错过或几乎同步；超时兜底投递一次
  window.setTimeout(() => {
    void deliver().finally(() => {
      unlistenShown();
    });
  }, 450);
}

async function handleAction(action: QuickLauncherAction): Promise<void> {
  switch (action.kind) {
    case "command":
      await runCommand(action.id);
      return;
    case "connection":
      await runLegacyConnection(action.id);
      return;
    case "ssh-connection":
    case "db-connection":
    case "db-database":
    case "db-table":
      await wakeMainFromTray();
      applyQuickLauncherResourceAction(action);
      return;
    default:
      break;
  }
}

/** 主窗口注册：监听快捷启动窗发出的动作（非 SOLO 路径）。 */
export function initQuickLauncherActionListener(): () => void {
  let unlisten: (() => void) | undefined;
  void listenQuickLauncherAction((action) => {
    void handleAction(action);
  }).then((fn) => {
    unlisten = fn;
  });
  return () => unlisten?.();
}

/**
 * 模块独立窗注册：接收 SOLO 模式下发来的资源打开动作。
 * 仅处理与当前模块匹配的动作。
 */
export function initModuleQuickLauncherActionListener(moduleKey: ModuleKey): () => void {
  let unlisten: UnlistenFn | undefined;
  void listen<QuickLauncherAction>(MODULE_QUICK_ACTION_EVENT, (event) => {
    const action = event.payload;
    if (!action?.kind) return;
    const target = moduleKeyForQuickLauncherAction(action);
    if (target !== moduleKey) return;
    // 确认当前确实是模块窗（避免主窗误收）
    const params = parseModuleWindowParams();
    if (!params || params.moduleKey !== moduleKey) return;
    applyQuickLauncherResourceAction(action);
  }).then((fn) => {
    unlisten = fn;
  });
  return () => unlisten?.();
}
