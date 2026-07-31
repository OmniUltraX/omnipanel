import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  listenQuickLauncherAction,
  syncTrayActiveToBackend,
  type QuickLauncherAction,
} from "./quickLauncher";
import { clearWindowHiddenToTray, getTrayHiddenLabels } from "./trayHiddenWindows";
import { focusMainWindow, goWorkspaceHome } from "./workspaceNavigation";
import { MODULE_PATHS, type ModuleKey } from "./paths";
import {
  navigateToPath,
  openLocalTerminalSession,
  openSshTerminalSession,
  getResourceIdForTab,
} from "./terminalSession";
import { useConnectionStore } from "../stores/connectionStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useTerminalLeftPanelStore } from "../modules/terminal/terminalLeftPanelStore";
import { followUiIntent } from "./ai/uiFollow";
import {
  listenModuleWindowShown,
  openModuleWindow,
  parseModuleWindowParams,
} from "./moduleWindow";
import { sendToAiDock } from "./ai/sendToAiDock";
import { useCommandBarDraftStore } from "../modules/terminal/commandBarDraftStore";
import { requestTerminalExecution } from "../modules/terminal/executeTerminalCommand";

const DOCKER_ACTIVE_KEY = "omnipanel.docker.activeConnectionId";
const MODULE_QUICK_ACTION_EVENT = "omnipanel:module-quick-action";

async function wakeMainFromTray(): Promise<void> {
  for (const label of getTrayHiddenLabels()) {
    clearWindowHiddenToTray(label);
  }
  await syncTrayActiveToBackend(false);
  await focusMainWindow();
}

/** SOLO 模块窗内执行动作时不要唤醒主窗。 */
async function wakeMainUnlessModuleWindow(): Promise<void> {
  if (parseModuleWindowParams()) return;
  await wakeMainFromTray();
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

/** 等终端 pane sender 就绪后再执行（新建 Tab 需短暂等待挂载）。 */
async function waitForTerminalSender(tabId: string, timeoutMs = 2500): Promise<boolean> {
  const { terminalPaneSenders } = await import("../modules/terminal/terminalPaneSenders");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (terminalPaneSenders[tabId]) return true;
    await new Promise((r) => window.setTimeout(r, 50));
  }
  return Boolean(terminalPaneSenders[tabId]);
}

async function runTerminalAction(action: Extract<QuickLauncherAction, { kind: "run-terminal" }>) {
  await wakeMainUnlessModuleWindow();
  const tabId = action.resourceId
    ? openSshTerminalSession(action.resourceId) ?? openLocalTerminalSession()
    : openLocalTerminalSession();

  if (!action.execute) {
    useCommandBarDraftStore.getState().setDraft(tabId, action.command);
    return;
  }

  await waitForTerminalSender(tabId);
  // 执行前再聚焦一次：冷启动时 dock 可能在 sender 就绪后才挂上
  useTerminalStore.getState().setActiveTab(tabId);
  window.dispatchEvent(
    new CustomEvent("omnipanel-terminal-focus-tab", { detail: { tabId } }),
  );
  requestTerminalExecution({
    tabId,
    command: action.command,
    resourceId: getResourceIdForTab(tabId),
    source: "用户",
  });
}

async function runSqlAction(action: Extract<QuickLauncherAction, { kind: "run-sql" }>) {
  await wakeMainUnlessModuleWindow();
  navigateToPath(MODULE_PATHS.database);
  followUiIntent({
    type: "openSqlDraft",
    connectionId: action.connectionId,
    database: action.database ?? null,
    sql: action.sql,
    autoRun: action.mode === "execute",
  });
}

async function runAskAiAction(action: Extract<QuickLauncherAction, { kind: "ask-ai" }>) {
  await wakeMainUnlessModuleWindow();
  await sendToAiDock(action.prompt, { newConversation: true, openDrawer: true });
}

async function runSaveNoteAction(action: Extract<QuickLauncherAction, { kind: "save-note" }>) {
  await wakeMainUnlessModuleWindow();
  navigateToPath(MODULE_PATHS.knowledge);
  const { useKnowledgeStore } = await import("../stores/knowledgeStore");
  const store = useKnowledgeStore.getState();
  await store.loadEntries().catch(() => {});
  const id = await store.createDocument();
  if (!id) return;
  const entry = useKnowledgeStore.getState().entries.find((e) => e.id === id);
  if (!entry) return;
  await store.saveEntry({
    ...entry,
    title: action.title.slice(0, 120) || "未命名文档",
    content: action.content,
  });
  followUiIntent({ type: "openDocument", entryId: id, mode: "permanent" });
}

async function runCreateTodoAction(action: Extract<QuickLauncherAction, { kind: "create-todo" }>) {
  await wakeMainUnlessModuleWindow();
  navigateToPath(MODULE_PATHS.tasks);
  const { useUserTodoStore } = await import("../stores/userTodoStore");
  const store = useUserTodoStore.getState();
  await store.loadLists().catch(() => {});
  await store.createTask(action.title.slice(0, 200) || "待办");
}

async function runOpenUrlAction(action: Extract<QuickLauncherAction, { kind: "open-url" }>) {
  await wakeMainUnlessModuleWindow();
  if (action.target === "browser") {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open(action.url);
    } catch (e) {
      console.warn("[quickLauncher] open browser failed", e);
      window.open(action.url, "_blank", "noopener,noreferrer");
    }
    return;
  }
  // HTTP 协议调试：导航到协议模块（预填 URL 暂无公共 helper，先打开模块）
  navigateToPath(MODULE_PATHS.protocol);
  try {
    sessionStorage.setItem("omnipanel.protocol.pendingUrl", action.url);
  } catch {
    /* ignore */
  }
}

async function runOpenPathAction(action: Extract<QuickLauncherAction, { kind: "open-path" }>) {
  await wakeMainUnlessModuleWindow();
  navigateToPath(MODULE_PATHS.files);
  try {
    sessionStorage.setItem("omnipanel.files.pendingPath", action.path);
  } catch {
    /* ignore */
  }
}

/** 资源类动作对应的目标模块（SOLO 独立窗）。 */
export function moduleKeyForQuickLauncherAction(
  action: QuickLauncherAction,
): ModuleKey | null {
  switch (action.kind) {
    case "ssh-connection":
    case "run-terminal":
      return "terminal";
    case "db-connection":
    case "db-database":
    case "db-table":
    case "run-sql":
      return "database";
    case "save-note":
      return "knowledge";
    case "create-todo":
      return "tasks";
    case "open-url":
      return action.target === "http" ? "protocol" : null;
    case "open-path":
      return "files";
    case "ask-ai":
      return null;
    default:
      return null;
  }
}

/** 在当前 WebView 内执行资源打开（SSH / DB）与智能建议动作。 */
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
    case "run-terminal":
      void runTerminalAction(action);
      return;
    case "run-sql":
      void runSqlAction(action);
      return;
    case "ask-ai":
      void runAskAiAction(action);
      return;
    case "save-note":
      void runSaveNoteAction(action);
      return;
    case "create-todo":
      void runCreateTodoAction(action);
      return;
    case "open-url":
      void runOpenUrlAction(action);
      return;
    case "open-path":
      void runOpenPathAction(action);
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
    case "run-terminal":
    case "run-sql":
    case "ask-ai":
    case "save-note":
    case "create-todo":
    case "open-url":
    case "open-path":
      await wakeMainFromTray();
      applyQuickLauncherResourceAction(action);
      return;
    default:
      break;
  }
}

/** 主窗口注册：监听快捷启动窗发出的动作（非 SOLO 路径）。 */
export function initQuickLauncherActionListener(): () => void {
  let cancelled = false;
  let unlisten: (() => void) | undefined;
  void listenQuickLauncherAction((action) => {
    void handleAction(action);
  }).then((fn) => {
    // React StrictMode 会先 cleanup 再 remount；listen 的 Promise 可能晚于 cleanup
    if (cancelled) {
      fn();
      return;
    }
    unlisten = fn;
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/**
 * 模块独立窗注册：接收 SOLO 模式下发来的资源打开动作。
 * 仅处理与当前模块匹配的动作。
 */
export function initModuleQuickLauncherActionListener(moduleKey: ModuleKey): () => void {
  let cancelled = false;
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
    if (cancelled) {
      fn();
      return;
    }
    unlisten = fn;
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
