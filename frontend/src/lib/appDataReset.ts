import { commands } from "../ipc/bindings";
import { disposeTabBackendSessions } from "../hooks/useTerminal";
import { DOCKER_LOCAL_CONNECTION_ID } from "../modules/docker/constants";
import { LOCAL_CONNECTION_ID } from "../modules/files/utils";
import {
  CLIENT_SYNC_MODULES_APPLIED_EVENT,
  scheduleClientModuleSync,
  setClientModuleSyncSuppressed,
} from "../modules/clientSync/moduleSync";
import {
  recordModuleTombstones,
} from "../modules/clientSync/tombstones";
import {
  setSecretsVaultSyncSuppressed,
} from "../modules/clientSync/secretsVaultSync";
import { invalidatePathListingCache } from "../modules/terminal/commandBar/pathListingCache";
import { useConnectionStore } from "../stores/connectionStore";
import { useAiStore } from "../stores/aiStore";
import { useAiModelsStore } from "../stores/aiModelsStore";
import { useAcpServicesStore, initAcpServicesStore } from "../stores/acpServicesStore";
import { useDbConnectionListStore } from "../stores/dbConnectionListStore";
import { useDbDockLayoutStore } from "../stores/dbDockLayoutStore";
import { useDockerSidebarCacheStore } from "../stores/dockerSidebarCacheStore";
import { useFileManagerStore } from "../stores/fileManagerStore";
import { useFilesClipboardStore } from "../stores/filesClipboardStore";
import { useKnowledgeStore } from "../stores/knowledgeStore";
import { useKnowledgeTodoStore } from "../stores/knowledgeTodoStore";
import { useUserTodoStore } from "../stores/userTodoStore";
import { BUILTIN_SERVER_GROUPS, useServerGroupStore } from "../stores/serverGroupStore";
import { useServerTabStore } from "../stores/serverTabStore";
import {
  AI_DOCK_WIDTH_DEFAULT,
  useSettingsStore,
} from "../stores/settingsStore";
import { useShortcutsStore } from "../stores/shortcutsStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useTerminalDockLayoutStore } from "../stores/terminalDockLayoutStore";
import { useFilesWorkspaceSessionStore } from "../stores/filesWorkspaceSessionStore";
import { useFilesFavoritesStore } from "../stores/filesFavoritesStore";
import { useWorkflowStore } from "../stores/workflowStore";
import { DEFAULT_WORKSPACE, useWorkspaceStore } from "../stores/workspaceStore";
import { useWorkspaceBottomDockStore } from "../stores/workspaceBottomDockStore";
import { useSshHostStore } from "../stores/sshHostStore";
import { forceReleaseSshPoolSession } from "../stores/sshPoolSessionStore";
import { forgetSshMonitoring } from "../stores/sshMonitoringLifecycle";
import { useProtocolWorkspaceStore } from "../stores/protocolWorkspaceStore";
import { resetModuleTabs } from "../hooks/usePersistedModuleTab";
import { clearDatabaseModuleData } from "./clearDatabaseModuleData";

const PROTECTED_CONNECTION_IDS = new Set([
  DOCKER_LOCAL_CONNECTION_ID,
  LOCAL_CONNECTION_ID,
]);

/** 清除布局习惯：Dock 分屏、模块 Tab、快捷键覆盖、侧栏选择记忆等 */
export function clearAppLayoutCache(): void {
  useTerminalDockLayoutStore.getState().reset();
  useDbDockLayoutStore.getState().reset();
  useFilesWorkspaceSessionStore.getState().reset();
  useWorkspaceBottomDockStore.getState().resetAll();
  resetModuleTabs();
  useShortcutsStore.getState().resetAll();
  useServerTabStore.setState({ byGroup: {} });
  useWorkspaceStore.setState({ selectedResourceByPath: {} });
  useSettingsStore.getState().setAiDockWidth(AI_DOCK_WIDTH_DEFAULT);
  invalidatePathListingCache();
  useDockerSidebarCacheStore.setState({
    connections: {},
    refreshingKeys: {},
  });
  useProtocolWorkspaceStore.getState().reset();
}

async function clearHttpProtocolData(): Promise<void> {
  const collectionIds: string[] = [];
  const requestIds: string[] = [];
  const environmentIds: string[] = [];

  const collections = await commands.httpListCollections().catch(() => null);
  if (collections && collections.status === "ok") {
    for (const col of collections.data) {
      collectionIds.push(col.id);
      await commands.httpDeleteCollection(col.id).catch(() => undefined);
    }
  }

  const requests = await commands.httpListRequests(null).catch(() => null);
  if (requests && requests.status === "ok") {
    for (const req of requests.data) {
      requestIds.push(req.id);
      await commands.httpDeleteRequest(req.id).catch(() => undefined);
    }
  }

  const environments = await commands.httpListEnvironments().catch(() => null);
  if (environments && environments.status === "ok") {
    for (const env of environments.data) {
      environmentIds.push(env.id);
      await commands.httpDeleteEnvironment(env.id).catch(() => undefined);
    }
  }

  if (collectionIds.length) recordModuleTombstones("httpCollection", collectionIds);
  if (requestIds.length) recordModuleTombstones("httpRequest", requestIds);
  if (environmentIds.length) recordModuleTombstones("httpEnvironment", environmentIds);

  await commands.httpClearHistory().catch(() => undefined);
}

/** 删除统一连接表中的用户连接（Docker / 文件 / SSH 等），并写 tombstone 防云端回灌。 */
async function clearUnifiedConnections(): Promise<void> {
  const connRes = await commands.connList();
  if (connRes.status !== "ok") return;

  const toDelete = connRes.data.filter((c) => !PROTECTED_CONNECTION_IDS.has(c.id));
  if (toDelete.length === 0) {
    await useConnectionStore.getState().refresh();
    return;
  }

  recordModuleTombstones(
    "connection",
    toDelete.map((c) => c.id),
  );

  for (const conn of toDelete) {
    await commands.connDelete(conn.id).catch(() => undefined);
    if (conn.kind === "ssh") {
      forgetSshMonitoring(conn.id);
      useSshHostStore.getState().clearHost(conn.id);
      forceReleaseSshPoolSession(conn.id);
    }
    if (conn.kind === "docker") {
      useDockerSidebarCacheStore.getState().removeConnection(conn.id);
      await commands.dockerRemoveSidebarCache(conn.id).catch(() => undefined);
    }
  }

  await useConnectionStore.getState().refresh();
}

/** 清除各模块用户创建的数据与资源（连接、任务、工作流、终端会话等） */
export async function clearAppUserData(): Promise<void> {
  setClientModuleSyncSuppressed(true);
  setSecretsVaultSyncSuppressed(true);
  try {
    await clearUnifiedConnections();

    const tabs = useTerminalStore.getState().tabs;
    const sessions = useTerminalStore.getState().sessions;
    for (const tab of tabs) {
      disposeTabBackendSessions(tab.sessionId);
    }
    for (const session of sessions) {
      if (session.lifecycle !== "ended") {
        disposeTabBackendSessions(session.id);
      }
    }
    useTerminalStore.setState({
      sessions: [],
      tabs: [],
      activeTabId: null,
      activeSessionId: null,
      detachedRuntime: {},
    });

    useAiStore.setState({ conversations: [], activeConversationId: null });
    useAiModelsStore.getState().resetProviders();
    useAcpServicesStore.getState().resetServices();
    await initAcpServicesStore();

    const taskRes = await commands.taskList(null, 500);
    if (taskRes.status === "ok") {
      for (const task of taskRes.data) {
        await commands.taskDelete(task.id);
      }
    }

    const workflowRes = await commands.workflowList();
    if (workflowRes.status === "ok") {
      for (const wf of workflowRes.data) {
        await commands.workflowDelete(wf.id);
      }
    }
    useWorkflowStore.setState({
      workflows: [],
      selectedDetail: null,
      executions: [],
      selectedWorkflowId: null,
      error: null,
    });

    const knowledgeRes = await commands.knowledgeList(null, null);
    if (knowledgeRes.status === "ok") {
      const knowledgeIds = knowledgeRes.data.map((entry) => entry.id);
      if (knowledgeIds.length) recordModuleTombstones("knowledge", knowledgeIds);
      for (const entry of knowledgeRes.data) {
        await commands.knowledgeDelete(entry.id);
      }
    }
    useKnowledgeStore.setState({
      entries: [],
      expandedIds: [],
      selectedEntryId: null,
      searchQuery: "",
      error: null,
    });

    const todoRes = await commands.knowledgeTodoList();
    if (todoRes.status === "ok") {
      for (const list of todoRes.data) {
        await commands.knowledgeTodoDelete(list.id);
      }
    }
    useKnowledgeTodoStore.setState({
      lists: [],
      editingId: null,
      error: null,
    });

    const userLists = await commands.todoListList();
    if (userLists.status === "ok") {
      for (const list of userLists.data) {
        if (list.isDefault) {
          const tasks = await commands.todoTaskList({
            view: "list",
            listId: list.id,
            includeCompleted: true,
          });
          if (tasks.status === "ok") {
            for (const task of tasks.data) {
              await commands.todoTaskDelete(task.id);
            }
          }
          continue;
        }
        await commands.todoListDelete(list.id);
      }
    }
    useUserTodoStore.setState({
      lists: [],
      tasks: [],
      selectedTask: null,
      error: null,
    });

    await clearHttpProtocolData();

    await commands.terminalHistoryClearAll().catch(() => undefined);
    const { clearTerminalHistoryData } = await import("../stores/terminalHistoryStore");
    clearTerminalHistoryData();

    useServerGroupStore.setState({
      groups: BUILTIN_SERVER_GROUPS,
      activeGroupId: "default",
    });
    await clearDatabaseModuleData();
    await useDbConnectionListStore.getState().refresh();

    useFileManagerStore.setState({ transfers: [], hydrated: false });
    useFilesFavoritesStore.getState().reset();
    useFilesClipboardStore.getState().clear();
    useFilesWorkspaceSessionStore.getState().reset();

    const workspaceState = useWorkspaceStore.getState();
    for (const ws of [...workspaceState.workspaces]) {
      if (ws.id !== DEFAULT_WORKSPACE.id) {
        workspaceState.removeWorkspace(ws.id);
      }
    }
    useWorkspaceStore.setState({
      workspace: DEFAULT_WORKSPACE,
      workspaces: [DEFAULT_WORKSPACE],
      activeResourceId: "local-terminal",
      selectedResourceByPath: {},
    });

    useWorkspaceBottomDockStore.getState().resetAll();
  } finally {
    setClientModuleSyncSuppressed(false);
    setSecretsVaultSyncSuppressed(false);
  }
}

/**
 * 清除缓存（完整）：布局习惯 + 全部用户数据与资源。
 * 内置本地 Docker / 文件连接由后端注入，会保留。
 */
export async function clearAppCache(): Promise<void> {
  await clearAppUserData();
  clearAppLayoutCache();
  // 通知 Database / Docker / Files 等面板立即重载连接列表
  window.dispatchEvent(new CustomEvent(CLIENT_SYNC_MODULES_APPLIED_EVENT));
  // 推送空模块 + tombstone，避免云端快照把连接拉回来
  scheduleClientModuleSync();
}
