import {
  useEffect,
  useCallback,
  useState,
  useMemo,
  type SetStateAction,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  useTerminalStore,
  type TerminalPane,
  type TerminalTab,
} from "../../stores/terminalStore";
import {
  clearPaneBackendPending,
  disposePaneBackendSession,
  disposeTabBackendSessions,
} from "../../hooks/useTerminal";
import { resolveResourceById, useSshHostResources } from "../../stores/connectionStore";
import { openSshTerminalSession } from "../../lib/terminalSession";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { useServerViewStore } from "../../stores/serverViewStore";
import { useActionStore } from "../../stores/actionStore";
import { useTopbarTabs } from "../../hooks/useTopbarTabs";
import { useI18n } from "../../i18n";
import {
  SplitTerminalWorkspace,
  useSplitTerminalWorkspace,
  type SplitTerminalPaneInput,
} from "../../components/terminal/split-workspace";
import { formatPaneHeaderTitle } from "./paneHeader";
import {
  buildPaneResourcePatch,
  LOCAL_TERMINAL_RESOURCE_ID,
} from "./paneResource";
import { getBlueprint } from "./sessionBlueprints";
import type { LayoutNode } from "./splitLayout";

const EMPTY_PANES: TerminalPane[] = [];

function tabLabel(tab: TerminalTab) {
  const pane =
    tab.panes.find((item) => item.id === tab.activePaneId) ?? tab.panes[0];
  if (!pane) return tab.title;
  const resource = resolveResourceById(pane.resourceId);
  return formatPaneHeaderTitle(resource, pane);
}

export function TerminalPanel() {
  const { t } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const isActiveRoute = location.pathname === "/terminal";
  const tabs = useTerminalStore((state) => state.tabs);
  const activeTabId = useTerminalStore((state) => state.activeTabId);
  const removeTab = useTerminalStore((state) => state.removeTab);
  const setActiveTab = useTerminalStore((state) => state.setActiveTab);
  const openOrFocusLocalTab = useTerminalStore((state) => state.openOrFocusLocalTab);
  const setActivePane = useTerminalStore((state) => state.setActivePane);
  const workspaceActiveResourceId = useWorkspaceStore(
    (state) => state.activeResourceId,
  );
  const workspaceActiveResource =
    resolveResourceById(workspaceActiveResourceId) ??
    resolveResourceById(LOCAL_TERMINAL_RESOURCE_ID);
  const selectResource = useWorkspaceStore((state) => state.selectResource);
  const enqueueAction = useActionStore((state) => state.enqueueAction);
  const sshHosts = useSshHostResources();

  // Layout state for each tab
  const [layouts, setLayouts] = useState<Record<string, LayoutNode>>({});

  // 本地终端仅保留一个 Tab：统一走 openOrFocusLocalTab，并清理历史重复项
  useEffect(() => {
    const localTabs = tabs.filter((tab) =>
      tab.panes.some(
        (pane) => pane.type === "local" && pane.resourceId === "local-terminal",
      ),
    );

    if (localTabs.length > 1) {
      const keepId =
        activeTabId && localTabs.some((tab) => tab.id === activeTabId)
          ? activeTabId
          : localTabs[0].id;
      localTabs
        .filter((tab) => tab.id !== keepId)
        .forEach((tab) => {
          disposeTabBackendSessions(tab.id);
          removeTab(tab.id);
        });
      setActiveTab(keepId);
      return;
    }

    if (localTabs.length === 0) {
      const id = openOrFocusLocalTab(
        workspaceActiveResource?.name ?? "本地终端",
      );
      setActiveTab(id);
      return;
    }

    if (!activeTabId) {
      setActiveTab(localTabs[0].id);
    }
  }, [
    activeTabId,
    openOrFocusLocalTab,
    removeTab,
    setActiveTab,
    tabs,
    workspaceActiveResource?.name,
  ]);

  const activeWorkspaceTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null,
    [tabs, activeTabId],
  );

  const currentLayout = activeWorkspaceTab
    ? (layouts[activeWorkspaceTab.id] ?? null)
    : null;

  const setTabLayout = useCallback(
    (value: SetStateAction<LayoutNode | null>) => {
      if (!activeWorkspaceTab) return;
      const tabKey = activeWorkspaceTab.id;
      setLayouts((prev) => {
        const resolved =
          typeof value === "function" ? value(prev[tabKey] ?? null) : value;
        if (resolved === null) {
          if (!(tabKey in prev)) return prev;
          const next = { ...prev };
          delete next[tabKey];
          return next;
        }
        if (prev[tabKey] === resolved) return prev;
        return { ...prev, [tabKey]: resolved };
      });
    },
    [activeWorkspaceTab?.id],
  );

  const onCommandExecuted = useCallback(
    (command: string, paneId: string, pane: TerminalPane) => {
      const targetTab = tabs.find((tab) =>
        tab.panes.some((item) => item.id === paneId),
      );
      if (!targetTab) return;
      const targetResource =
        resolveResourceById(pane.resourceId) ?? workspaceActiveResource;
      enqueueAction({
        type: "terminal",
        title: t("terminal.actions.command"),
        description: `${targetTab.title} · ${command}`,
        command,
        resourceId: targetResource?.id ?? pane.resourceId,
        source: "用户",
      });
    },
    [enqueueAction, tabs, t, workspaceActiveResource],
  );

  const onActivePaneChange = useCallback(
    (paneId: string) => {
      if (activeWorkspaceTab) {
        setActivePane(activeWorkspaceTab.id, paneId);
      }
    },
    [activeWorkspaceTab, setActivePane],
  );

  const onAddPane = useCallback(
    (partial: SplitTerminalPaneInput) => {
      if (!activeWorkspaceTab) return;
      useTerminalStore.getState().addPaneToTab(activeWorkspaceTab.id, {
        ...partial,
        terminal: null,
        status: "connecting",
        backendSessionId: null,
      });
    },
    [activeWorkspaceTab],
  );

  const onRemovePane = useCallback(
    (paneId: string) => {
      if (!activeWorkspaceTab) return;
      disposePaneBackendSession(paneId);
      useTerminalStore
        .getState()
        .removePaneFromTab(activeWorkspaceTab.id, paneId);
    },
    [activeWorkspaceTab],
  );

  const workspacePanes = activeWorkspaceTab?.panes ?? EMPTY_PANES;

  const paneServerOptions = useMemo(
    () => [
      {
        id: LOCAL_TERMINAL_RESOURCE_ID,
        label: t("terminal.newSession.local"),
      },
      ...sshHosts.map((host) => ({
        id: host.id,
        label: host.name,
      })),
    ],
    [sshHosts, t],
  );

  const handlePaneResourceChange = useCallback(
    (paneId: string, resourceId: string) => {
      const pane = workspacePanes.find((item) => item.id === paneId);
      if (!pane || pane.resourceId === resourceId) return;

      disposePaneBackendSession(paneId);
      clearPaneBackendPending(paneId);
      useTerminalStore
        .getState()
        .setPaneResource(paneId, buildPaneResourcePatch(resourceId));

      if (activeWorkspaceTab?.activePaneId === paneId) {
        selectResource(resourceId);
      }
    },
    [activeWorkspaceTab?.activePaneId, selectResource, workspacePanes],
  );

  const {
    layout: splitLayout,
    handlePaneSenderChange,
    handleCommand,
    handleActivatePane,
    handleSplitPane,
    handleClosePane,
  } = useSplitTerminalWorkspace({
    workspaceId: activeWorkspaceTab?.id ?? "__terminal_inactive__",
    panes: workspacePanes,
    activePaneId: activeWorkspaceTab?.activePaneId ?? null,
    onActivePaneChange,
    onAddPane,
    onRemovePane,
    onCommandExecuted,
    layout: currentLayout,
    setLayout: setTabLayout,
  });

  const activePane = useMemo(() => {
    if (!activeWorkspaceTab) return null;
    return (
      activeWorkspaceTab.panes.find(
        (pane) => pane.id === activeWorkspaceTab.activePaneId,
      ) ?? activeWorkspaceTab.panes[0] ?? null
    );
  }, [activeWorkspaceTab]);

  useEffect(() => {
    if (!isActiveRoute || !activePane?.resourceId) return;
    if (activePane.resourceId !== workspaceActiveResourceId) {
      selectResource(activePane.resourceId);
    }
  }, [
    activePane?.resourceId,
    isActiveRoute,
    selectResource,
    workspaceActiveResourceId,
  ]);

  const handleAddLocalTab = useCallback(() => {
    const id = openOrFocusLocalTab(
      workspaceActiveResource?.name ?? "本地终端",
    );
    setActiveTab(id);
  }, [openOrFocusLocalTab, setActiveTab, workspaceActiveResource?.name]);

  const handleCloseTab = useCallback(
    (id: string) => {
      if (tabs.length <= 1) return;
      disposeTabBackendSessions(id);
      removeTab(id);
      setLayouts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    },
    [tabs.length, removeTab],
  );

  const addMenuItems = useMemo(
    () => [
      {
        id: "local",
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

  const handleAddMenuSelect = useCallback(
    (id: string) => {
      if (id === "local") {
        handleAddLocalTab();
        return;
      }
      if (id === "manage-hosts") {
        useServerViewStore.getState().setViewTab("terminal");
        navigate("/server");
        return;
      }
      openSshTerminalSession(id);
    },
    [handleAddLocalTab, navigate],
  );

  const topbarTabs = useMemo(
    () =>
      tabs.map((tab) => {
        const pane =
          tab.panes.find((item) => item.id === tab.activePaneId) ??
          tab.panes[0];
        return {
          id: tab.id,
          label: tabLabel(tab),
          active: tab.id === activeTabId,
          closable: tabs.length > 1,
          status:
            pane?.status === "disconnected"
              ? ("offline" as const)
              : (pane?.status ?? ("offline" as const)),
        };
      }),
    [tabs, activeTabId],
  );

  useTopbarTabs(
    topbarTabs,
    {
      onSelect: setActiveTab,
      onClose: handleCloseTab,
      addMenuItems,
      onAddMenuSelect: handleAddMenuSelect,
    },
    { mode: "session", showAddTab: true, enabled: isActiveRoute },
  );

  if (!activeWorkspaceTab || !activePane) return null;

  return (
    <SplitTerminalWorkspace
      panes={activeWorkspaceTab.panes}
      layout={splitLayout}
      activePaneId={activeWorkspaceTab.activePaneId}
      getResource={(pane) =>
        resolveResourceById(pane.resourceId) ?? workspaceActiveResource
      }
      serverOptions={paneServerOptions}
      onPaneResourceChange={handlePaneResourceChange}
      paneStartup={(pane) =>
        getBlueprint(
          resolveResourceById(pane.resourceId) ?? workspaceActiveResource,
          pane,
        ).startup
      }
      onActivatePane={handleActivatePane}
      onSendCommand={handleCommand}
      onSenderChange={handlePaneSenderChange}
      onSplitPane={handleSplitPane}
      onClosePane={handleClosePane}
    />
  );
}
