import { commands } from "../ipc/bindings";
import { disposeTabBackendSessions } from "../hooks/useTerminal";
import { DOCKER_LOCAL_CONNECTION_ID } from "../modules/docker/constants";
import { LOCAL_CONNECTION_ID } from "../modules/files/utils";
import { useConnectionStore } from "../stores/connectionStore";
import { useAiStore } from "../stores/aiStore";
import { useAiModelsStore } from "../stores/aiModelsStore";
import { useAcpServicesStore } from "../stores/acpServicesStore";
import { useDbDockLayoutStore } from "../stores/dbDockLayoutStore";
import { useFileManagerStore } from "../stores/fileManagerStore";
import { useKnowledgeStore } from "../stores/knowledgeStore";
import { useKnowledgeTodoStore } from "../stores/knowledgeTodoStore";
import { BUILTIN_SERVER_GROUPS, useServerGroupStore } from "../stores/serverGroupStore";
import { useServerTabStore } from "../stores/serverTabStore";
import {
  AI_DOCK_WIDTH_DEFAULT,
  useSettingsStore,
} from "../stores/settingsStore";
import { useShortcutsStore } from "../stores/shortcutsStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useTerminalDockLayoutStore } from "../stores/terminalDockLayoutStore";
import { useFilesDockLayoutStore } from "../stores/filesDockLayoutStore";
import { useWorkflowStore } from "../stores/workflowStore";
import { DEFAULT_WORKSPACE, useWorkspaceStore } from "../stores/workspaceStore";
import { useWorkspaceBottomDockStore } from "../stores/workspaceBottomDockStore";
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
  useFilesDockLayoutStore.getState().reset();
  useWorkspaceBottomDockStore.getState().resetAll();
  resetModuleTabs();
  useShortcutsStore.getState().resetAll();
  useServerTabStore.setState({ byGroup: {} });
  useWorkspaceStore.setState({ selectedResourceByPath: {} });
  useSettingsStore.getState().setAiDockWidth(AI_DOCK_WIDTH_DEFAULT);
}

/** 清除各模块用户创建的数据（连接、任务、工作流、终端会话等） */
export async function clearAppUserData(): Promise<void> {
  const connRes = await commands.connList();
  if (connRes.status === "ok") {
    for (const conn of connRes.data) {
      if (PROTECTED_CONNECTION_IDS.has(conn.id)) continue;
      await commands.connDelete(conn.id);
    }
  }
  await useConnectionStore.getState().refresh();

  const tabs = useTerminalStore.getState().tabs;
  for (const tab of tabs) {
    disposeTabBackendSessions(tab.id);
  }
  useTerminalStore.setState({ tabs: [], activeTabId: null });

  useAiStore.setState({ conversations: [], activeConversationId: null });
  useAiModelsStore.getState().resetProviders();
  useAcpServicesStore.getState().resetServices();

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

  await commands.httpClearHistory().catch(() => undefined);

  const { clearTerminalHistoryData } = await import("../stores/terminalHistoryStore");
  clearTerminalHistoryData();

  useServerGroupStore.setState({
    groups: BUILTIN_SERVER_GROUPS,
    activeGroupId: "default",
  });
  await clearDatabaseModuleData();
  useFileManagerStore.setState({ transfers: [] });

  const workspaceState = useWorkspaceStore.getState();
  for (const ws of [...workspaceState.workspaces]) {
    if (ws.id !== DEFAULT_WORKSPACE.id) {
      workspaceState.removeWorkspace(ws.id);
    }
  }
  useWorkspaceStore.setState({
    workspace: DEFAULT_WORKSPACE,
    activeResourceId: "local-terminal",
    selectedResourceByPath: {},
  });

  useWorkspaceBottomDockStore.getState().resetAll();
}
