import { listenQuickLauncherAction, syncTrayActiveToBackend, type QuickLauncherAction } from "./quickLauncher";
import { clearWindowHiddenToTray, getTrayHiddenLabels } from "./trayHiddenWindows";
import { focusMainWindow, goWorkspaceHome } from "./workspaceNavigation";
import { MODULE_PATHS } from "./paths";
import { navigateToPath, openLocalTerminalSession, openSshTerminalSession } from "./terminalSession";
import { useConnectionStore } from "../stores/connectionStore";
import { useTerminalLeftPanelStore } from "../modules/terminal/terminalLeftPanelStore";
import { followUiIntent } from "./ai/uiFollow";

const DOCKER_ACTIVE_KEY = "omnipanel.docker.activeConnectionId";

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

async function handleAction(action: QuickLauncherAction): Promise<void> {
  switch (action.kind) {
    case "command":
      await runCommand(action.id);
      return;
    case "connection":
      await runLegacyConnection(action.id);
      return;
    case "ssh-connection":
      await wakeMainFromTray();
      openSshTerminalSession(action.connectionId);
      return;
    case "db-connection":
      await wakeMainFromTray();
      followUiIntent({
        type: "openConnection",
        module: "database",
        resourceId: action.connectionId,
      });
      return;
    case "db-database":
      await wakeMainFromTray();
      followUiIntent({
        type: "selectDatabase",
        connectionId: action.connectionId,
        database: action.database,
      });
      return;
    case "db-table":
      await wakeMainFromTray();
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

/** 主窗口注册：监听快捷启动窗发出的动作。 */
export function initQuickLauncherActionListener(): () => void {
  let unlisten: (() => void) | undefined;
  void listenQuickLauncherAction((action) => {
    void handleAction(action);
  }).then((fn) => {
    unlisten = fn;
  });
  return () => unlisten?.();
}
