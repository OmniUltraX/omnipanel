import { useCallback, useEffect, useMemo } from "react";
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
import { useI18n } from "../../i18n";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import type { TopbarTabDef } from "../../stores/topbarStore";
import { navigateToPath } from "../../lib/terminalSession";
import { LOCAL_TERMINAL_RESOURCE_ID } from "./paneResource";
import { TerminalTabDockPane } from "./TerminalTabDockPane";
import { clearTerminalPaneSender } from "./terminalPaneSenders";
import { useWorkspaceBottomDockStore } from "../../stores/workspaceBottomDockStore";

function tabLabel(tab: TerminalTab, fallbackName?: string) {
  const resource = resolveResourceById(tab.session.resourceId);
  return resource?.name ?? tab.title ?? fallbackName ?? tab.session.resourceId;
}

function topbarTabStatus(
  status: TerminalTab["status"],
): TopbarTabDef["status"] {
  if (status === "connected") return "connected";
  if (status === "connecting") return "connecting";
  if (status === "disconnected") return "offline";
  return "idle";
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
  const openOrFocusSshTab = useTerminalStore((state) => state.openOrFocusSshTab);
  const addLocalTerminalTab = useTerminalStore((state) => state.addLocalTerminalTab);
  const sshHosts = useSshHostResources();

  const workspaceActiveResourceId = useWorkspaceStore(
    (state) => state.activeResourceId,
  );
  const workspaceActiveResource =
    resolveResourceById(workspaceActiveResourceId) ??
    resolveResourceById(LOCAL_TERMINAL_RESOURCE_ID);
  const selectResource = useWorkspaceStore((state) => state.selectResource);

  const isOriginDocked = useWorkspaceBottomDockStore((s) => s.isOriginDocked);

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
      clearTerminalPaneSender(id);
      clearPaneBackendPending(id);
      disposeTabBackendSessions(id);
      removeTab(id);
    },
    [removeTab],
  );

  const visibleTabs = useMemo(
    () => tabs.filter((tab) => !isOriginDocked("terminal", tab.id)),
    [tabs, isOriginDocked],
  );

  const topbarTabs = useMemo(
    () =>
      visibleTabs.map((tab) => ({
        id: tab.id,
        label: tabLabel(tab),
        active: tab.id === activeTabId,
        closable: true,
        status: topbarTabStatus(tab.status),
      })),
    [visibleTabs, activeTabId],
  );

  const addMenuItems = useMemo(
    () => [
      {
        id: LOCAL_TERMINAL_RESOURCE_ID,
        label: t("terminal.newSession.local"),
        subtitle: t("terminal.newSession.localDesc"),
      },
      ...sshHosts.map((host) => ({
        id: host.id,
        label: host.name,
        subtitle: host.subtitle,
      })),
      {
        id: "manage-hosts",
        label: t("terminal.newSession.manageHosts"),
        subtitle: t("terminal.newSession.manageHostsDesc"),
        dividerBefore: true,
      },
    ],
    [sshHosts, t],
  );

  const handleTopbarAdd = useCallback(() => {
    const name = workspaceActiveResource?.name ?? t("terminal.newSession.local");
    const id = addLocalTerminalTab(name);
    setActiveTab(id);
  }, [addLocalTerminalTab, setActiveTab, workspaceActiveResource?.name, t]);

  const handleTopbarAddMenuSelect = useCallback(
    (id: string) => {
      if (id === "manage-hosts") {
        navigateToPath("/ssh");
        return;
      }
      if (id === LOCAL_TERMINAL_RESOURCE_ID) {
        const tabId = openOrFocusLocalTab(t("terminal.newSession.local"));
        selectResource(LOCAL_TERMINAL_RESOURCE_ID);
        setActiveTab(tabId);
        return;
      }
      const host = sshHosts.find((item) => item.id === id);
      if (host) {
        const tabId = openOrFocusSshTab(host.id, host.name);
        selectResource(host.id);
        setActiveTab(tabId);
      }
    },
    [
      openOrFocusLocalTab,
      openOrFocusSshTab,
      selectResource,
      setActiveTab,
      sshHosts,
      t,
    ],
  );

  useTopbarTabs(
    topbarTabs,
    {
      onSelect: setActiveTab,
      onClose: handleCloseTab,
      onAdd: handleTopbarAdd,
      addMenuItems,
      onAddMenuSelect: handleTopbarAddMenuSelect,
    },
    {
      mode: "session",
      showAddTab: true,
      addTabTitle: t("shell.topbar.newTab"),
      enabled: isActiveRoute,
    },
  );

  if (visibleTabs.length === 0) {
    return (
      <div className="term-workspace">
        <div className="term-workspace__empty">{t("terminal.newSession.local")}</div>
      </div>
    );
  }

  return (
    <div className="term-workspace">
      {visibleTabs.map((tab) => (
        <div
          key={tab.id}
          className={`term-workspace-pane${tab.id === activeTabId ? " is-active" : ""}`}
        >
          <TerminalTabDockPane
            tabId={tab.id}
            isActive={tab.id === activeTabId}
            onActivate={() => setActiveTab(tab.id)}
          />
        </div>
      ))}
    </div>
  );
}
