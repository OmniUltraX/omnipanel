import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation } from "react-router-dom";
import {
  useTerminalStore,
  type TerminalTab,
} from "../../stores/terminalStore";
import { disposeTabBackendSessions } from "../../hooks/useTerminal";
import { clearPaneBackendPending } from "../../hooks/useTerminal";
import {
  resolveResourceById,
  useSshHostResources,
} from "../../stores/connectionStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useActionStore } from "../../stores/actionStore";
import { useI18n } from "../../i18n";
import { LOCAL_TERMINAL_RESOURCE_ID, buildSessionInfoForResource } from "./paneResource";
import { TerminalTabPaneView } from "./TerminalPaneView";
import { DockableWorkspace } from "../../components/dock";
import { useTerminalDockLayoutStore } from "../../stores/terminalDockLayoutStore";

function tabLabel(tab: TerminalTab, fallbackName?: string) {
  const resource = resolveResourceById(tab.session.resourceId);
  return resource?.name ?? tab.title ?? fallbackName ?? tab.session.resourceId;
}

export function TerminalPanel() {
  const { t } = useI18n();
  const location = useLocation();
  const isActiveRoute = location.pathname === "/terminal";
  const tabs = useTerminalStore((state) => state.tabs);
  const activeTabId = useTerminalStore((state) => state.activeTabId);
  const removeTab = useTerminalStore((state) => state.removeTab);
  const setActiveTab = useTerminalStore((state) => state.setActiveTab);
  const openOrFocusLocalTab = useTerminalStore((state) => state.openOrFocusLocalTab);
  const addLocalTerminalTab = useTerminalStore((state) => state.addLocalTerminalTab);
  const setTabResource = useTerminalStore((state) => state.setTabResource);

  /** 每个 Tab 的"重新连接"计数器：自增即触发 TerminalView 重建。 */
  const [reconnectKeys, setReconnectKeys] = useState<Record<string, number>>({});
  const reconnectKeysRef = useRef(reconnectKeys);
  reconnectKeysRef.current = reconnectKeys;

  /**
   * 处于"重新连接中"的 tab 集合。点击刷新按钮时加入，连接尝试结束
   * （status 离开 connecting）时自动移除——以此驱动加载动画的显示。
   */
  const [reconnectingTabs, setReconnectingTabs] = useState<Record<string, boolean>>({});

  const workspaceActiveResourceId = useWorkspaceStore(
    (state) => state.activeResourceId,
  );
  const workspaceActiveResource =
    resolveResourceById(workspaceActiveResourceId) ??
    resolveResourceById(LOCAL_TERMINAL_RESOURCE_ID);
  const selectResource = useWorkspaceStore((state) => state.selectResource);
  const enqueueAction = useActionStore((state) => state.enqueueAction);
  const sshHosts = useSshHostResources();

  const dockLayout = useTerminalDockLayoutStore((s) => s.savedLayout);
  const setDockLayout = useTerminalDockLayoutStore((s) => s.setSavedLayout);

  const paneSendersRef = useRef<Record<string, (cmd: string) => void>>({});

  // 进入模块时若没有任何 Tab，则自动建一个本地终端
  useEffect(() => {
    if (tabs.length === 0) {
      const id = openOrFocusLocalTab(workspaceActiveResource?.name ?? "本地终端");
      setActiveTab(id);
      return;
    }
    if (!activeTabId || !tabs.some((tab) => tab.id === activeTabId)) {
      setActiveTab(tabs[0].id);
    }
  }, [tabs, activeTabId, openOrFocusLocalTab, setActiveTab, workspaceActiveResource?.name]);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null,
    [tabs, activeTabId],
  );

  const handleSenderChange = useCallback(
    (sessionId: string, sender: ((cmd: string) => void) | null) => {
      if (sender) {
        paneSendersRef.current[sessionId] = sender;
      } else {
        delete paneSendersRef.current[sessionId];
      }
    },
    [],
  );

  const handleSendCommand = useCallback(
    (command: string, tabId: string) => {
      paneSendersRef.current[tabId]?.(command);

      const targetTab = tabs.find((tab) => tab.id === tabId);
      if (!targetTab) return;
      const targetResource =
        resolveResourceById(targetTab.session.resourceId) ?? workspaceActiveResource;
      enqueueAction({
        type: "terminal",
        title: t("terminal.actions.command"),
        description: `${targetTab.title} · ${command}`,
        command,
        resourceId: targetResource?.id ?? targetTab.session.resourceId,
        source: "用户",
      });
    },
    [enqueueAction, tabs, t, workspaceActiveResource],
  );

  // 同步 workspace 资源选中（仅当面板处于激活路由时）
  useEffect(() => {
    if (!isActiveRoute || !activeTab?.session.resourceId) return;
    if (activeTab.session.resourceId !== workspaceActiveResourceId) {
      selectResource(activeTab.session.resourceId);
    }
  }, [
    activeTab?.session.resourceId,
    isActiveRoute,
    selectResource,
    workspaceActiveResourceId,
  ]);

  const handleCloseTab = useCallback(
    (id: string) => {
      delete paneSendersRef.current[id];
      clearPaneBackendPending(id);
      disposeTabBackendSessions(id);
      removeTab(id);
    },
    [removeTab],
  );

  const handleClosePanel = useCallback(
    (tabIds: string[]) => {
      for (const tabId of tabIds) {
        handleCloseTab(tabId);
      }
    },
    [handleCloseTab],
  );

  /** dock 面板上的 + 按钮回调：始终建一个本地终端。 */
  const handleAddLocal = useCallback(() => {
    const name = workspaceActiveResource?.name ?? "本地终端";
    const id = addLocalTerminalTab(name);
    setActiveTab(id);
    return id;
  }, [addLocalTerminalTab, setActiveTab, workspaceActiveResource?.name]);

  const dockTabs = useMemo(
    () => tabs.map((tab) => ({ id: tab.id, label: tabLabel(tab), closable: true })),
    [tabs],
  );

  const paneServerOptions = useMemo(
    () => [
      {
        value: LOCAL_TERMINAL_RESOURCE_ID,
        label: t("terminal.newSession.local"),
      },
      ...sshHosts.map((host) => ({
        value: host.id,
        label: host.name,
      })),
    ],
    [sshHosts, t],
  );

  /** 被其他面板占用的资源 id 集合（用于去重下拉中已连接目标） */
  const occupiedResourceIds = useMemo(() => {
    const set = new Set<string>();
    for (const tab of tabs) {
      set.add(tab.session.resourceId);
    }
    return set;
  }, [tabs]);

  /** 为单个 Tab 切换目标资源（同步 dispose 旧后端） */
  const handleTabServerChange = useCallback(
    (tabId: string, resourceId: string) => {
      if (resourceId === LOCAL_TERMINAL_RESOURCE_ID) {
        // 保留为本地目标时不做操作
        const current = useTerminalStore.getState().tabs.find((t) => t.id === tabId);
        if (current && current.session.resourceId === LOCAL_TERMINAL_RESOURCE_ID) {
          return;
        }
      }
      // dispose 旧后端会话（先清空 sender 引用，避免被悬空 sender 投递命令）
      delete paneSendersRef.current[tabId];
      clearPaneBackendPending(tabId);
      disposeTabBackendSessions(tabId);

      const next = buildSessionInfoForResource(resourceId);
      setTabResource(tabId, next);
    },
    [setTabResource],
  );

  /**
   * 重新连接当前 Tab：先 dispose 后端 PTY/SSH，再自增 reconnectKey 触发
   * TerminalView 重建（`useTerminal` 主 effect 重跑 → `ensureBackendSession`
   * 发现 `backendSessionId === null` → 走 `acquireBackendSession` 创建新会话）。
   */
  const handleReconnect = useCallback((tabId: string) => {
    delete paneSendersRef.current[tabId];
    clearPaneBackendPending(tabId);
    disposeTabBackendSessions(tabId);
    setReconnectKeys((prev) => ({ ...prev, [tabId]: (prev[tabId] ?? 0) + 1 }));
    setReconnectingTabs((prev) => ({ ...prev, [tabId]: true }));
  }, []);

  // 当一个 tab 状态从 connecting 落到 connected / disconnected，
  // 视为"重新连接尝试已结束"，关闭加载动画。
  useEffect(() => {
    setReconnectingTabs((prev) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const tabId of Object.keys(prev)) {
        if (!prev[tabId]) continue;
        const tab = tabs.find((item) => item.id === tabId);
        if (!tab) {
          changed = true;
          continue;
        }
        if (tab.status === "connecting") {
          next[tabId] = true;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [tabs]);

  const renderDockPanel = useCallback(
    (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId);
      if (!tab) return null;
      const resource = resolveResourceById(tab.session.resourceId) ?? null;
      const isActive = tabId === activeTabId;
      const reconnectKey = reconnectKeys[tabId] ?? 0;
      const isReconnecting = reconnectingTabs[tabId] === true;

      return (
        <TerminalTabPaneView
          paneId={tab.id}
          tab={tab}
          resource={resource}
          isActive={isActive}
          onActivate={() => setActiveTab(tabId)}
          onSendCommand={(cmd) => handleSendCommand(cmd, tabId)}
          onSenderChange={handleSenderChange}
          onServerChange={(resourceId) => handleTabServerChange(tabId, resourceId)}
          serverOptions={paneServerOptions}
          occupiedResourceIds={occupiedResourceIds}
          onReconnect={() => handleReconnect(tabId)}
          reconnectKey={reconnectKey}
          isReconnecting={isReconnecting}
        />
      );
    },
    [
      tabs,
      activeTabId,
      handleSendCommand,
      handleSenderChange,
      handleTabServerChange,
      handleReconnect,
      paneServerOptions,
      occupiedResourceIds,
      reconnectKeys,
      reconnectingTabs,
      setActiveTab,
    ],
  );

  return (
    <DockableWorkspace
      className="term-dock-workspace"
      tabs={dockTabs}
      activeTabId={activeTabId ?? ""}
      onActiveTabChange={setActiveTab}
      onCloseTab={handleCloseTab}
      onClosePanel={handleClosePanel}
      savedLayout={dockLayout}
      onSavedLayoutChange={setDockLayout}
      renderPanel={renderDockPanel}
      onAddTab={handleAddLocal}
      emptyContent={t("terminal.newSession.local")}
    />
  );
}
