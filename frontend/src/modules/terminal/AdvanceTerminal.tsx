import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import {
  DockHandle,
  DockLayout,
  DockPanel,
  DockableWorkspace,
  type DockableTab,
  type SerializedDockview,
} from "@/components/dock";
import { LocalFilePanel } from "@/components/files";
import { SftpPanel } from "@/components/sftp";
import { TunnelPanel } from "@/components/tunnel";
import { WorkspaceComponent } from "@/components/workspace/WorkspaceComponent";
import { useI18n } from "@/i18n";
import { normalizeTerminalCwdForSftp } from "@/modules/server/ssh/utils/parseCommandPaths";
import { useSshDetailNavigationStore } from "@/stores/sshDetailNavigationStore";
import { TerminalTabPaneView } from "./TerminalPaneView";
import { AdvanceTerminalMonitorStack } from "./AdvanceTerminalMonitorStack";
import { TerminalHistoryPanel } from "./TerminalHistoryPanel";
import { useTerminalTabDockPane } from "./useTerminalTabDockPane";

type LocalSidePanelId = "files" | "monitor" | "history";
type RemoteSidePanelId = "sftp" | "tunnel" | "processes" | "history";
type SidePanelId = LocalSidePanelId | RemoteSidePanelId;

type SidePanelWorkspaceSpec = {
  componentType: string;
  label: string;
  props?: Record<string, unknown>;
  snapshotId?: string;
};

/** 侧栏竖排 tab 轨宽度，与 global.css 中 dv-tabs-and-actions-container 一致 */
const SIDE_TAB_RAIL_PX = 38;

export type AdvanceTerminalProps = {
  tabId: string;
  isActive: boolean;
  onActivate?: () => void;
};

export function AdvanceTerminal({ tabId, isActive, onActivate }: AdvanceTerminalProps) {
  const { t } = useI18n();
  const { paneProps, resource, tab } = useTerminalTabDockPane(tabId, isActive, onActivate);

  const isRemoteSsh = useMemo(
    () => tab?.session.type === "remote" && resource?.type === "ssh",
    [tab?.session.type, resource?.type],
  );
  const isLocal = tab?.session.type === "local";

  const sideTabs = useMemo((): DockableTab[] => {
    const historyTab: DockableTab = {
      id: "history",
      label: t("terminal.sideTabs.history"),
      panelType: "terminal-side",
      closable: false,
    };
    if (isLocal) {
      return [
        historyTab,
        {
          id: "monitor",
          label: t("terminal.sideTabs.monitor"),
          panelType: "terminal-side",
          closable: false,
        },
        {
          id: "files",
          label: t("terminal.sideTabs.files"),
          panelType: "terminal-side",
          closable: false,
        },
      ];
    }
    return [
      historyTab,
      {
        id: "processes",
        label: t("ssh.detailTabs.processes"),
        panelType: "terminal-side",
        closable: false,
      },
      {
        id: "sftp",
        label: t("ssh.detailTabs.sftp"),
        panelType: "terminal-side",
        closable: false,
      },
      {
        id: "tunnel",
        label: t("ssh.detailTabs.tunnels"),
        panelType: "terminal-side",
        closable: false,
      },
    ];
  }, [isLocal, t]);

  const resolveSidePanelSpec = useCallback(
    (sideTabId: string): SidePanelWorkspaceSpec | null => {
      const sideTab = sideTabs.find((item) => item.id === sideTabId);
      if (sideTabId === "files") {
        return {
          componentType: "files.local-panel",
          label: sideTab?.label ?? t("terminal.sideTabs.files"),
          props: {},
          snapshotId: "files.local-panel",
        };
      }
      if (sideTabId === "monitor") {
        return {
          componentType: "terminal.side.monitor-local",
          label: sideTab?.label ?? t("terminal.sideTabs.monitor"),
          snapshotId: "terminal.side.monitor-local",
        };
      }
      if (sideTabId === "history") {
        return {
          componentType: "terminal.side.history",
          label: sideTab?.label ?? t("terminal.sideTabs.history"),
          snapshotId: `terminal.side.history:${tabId}`,
        };
      }
      if (!resource?.id) return null;
      if (sideTabId === "sftp") {
        return {
          componentType: "ssh.detail.sftp",
          label: sideTab?.label ?? t("ssh.detailTabs.sftp"),
          props: { resourceId: resource.id },
          snapshotId: `ssh.detail.sftp:${resource.id}`,
        };
      }
      if (sideTabId === "tunnel") {
        return {
          componentType: "ssh.detail.tunnel",
          label: sideTab?.label ?? t("ssh.detailTabs.tunnels"),
          props: { resourceId: resource.id },
          snapshotId: `ssh.detail.tunnel:${resource.id}`,
        };
      }
      if (sideTabId === "processes") {
        return {
          componentType: "terminal.side.monitor-remote",
          label: sideTab?.label ?? t("ssh.detailTabs.processes"),
          props: { resourceId: resource.id },
          snapshotId: `terminal.side.monitor-remote:${resource.id}`,
        };
      }
      return null;
    },
    [resource?.id, sideTabs, t, tabId],
  );

  const defaultSideTab = "history";
  const [activeSideTab, setActiveSideTab] = useState<SidePanelId>(defaultSideTab);
  const [sideContentCollapsed, setSideContentCollapsed] = useState(false);
  const sideContentCollapsedRef = useRef(false);
  const sidePanelRef = useRef<PanelImperativeHandle | null>(null);
  const expandedSideSizeRef = useRef<number>(0);
  const sideLayoutRef = useRef<SerializedDockview | null>(null);
  const handleSideLayoutChange = useCallback((layout: SerializedDockview | null) => {
    sideLayoutRef.current = layout;
  }, []);

  const resizeSidePanel = useCallback((collapsed: boolean) => {
    const handle = sidePanelRef.current;
    if (!handle) return;
    if (collapsed) {
      handle.resize(SIDE_TAB_RAIL_PX);
      return;
    }

    const restored =
      expandedSideSizeRef.current > SIDE_TAB_RAIL_PX + 8
        ? expandedSideSizeRef.current
        : Math.floor(window.innerWidth * 0.5);
    handle.resize(restored);
  }, []);

  const applySidePanelCollapsed = useCallback((collapsed: boolean) => {
    const handle = sidePanelRef.current;
    if (collapsed && handle) {
      const size = handle.getSize();
      if (size.inPixels > SIDE_TAB_RAIL_PX + 8) {
        expandedSideSizeRef.current = size.inPixels;
      }
    }
    sideContentCollapsedRef.current = collapsed;
    setSideContentCollapsed(collapsed);
  }, []);

  useLayoutEffect(() => {
    resizeSidePanel(sideContentCollapsed);
    const raf = requestAnimationFrame(() => resizeSidePanel(sideContentCollapsed));
    return () => cancelAnimationFrame(raf);
  }, [resizeSidePanel, sideContentCollapsed]);

  const handleSideTabChange = useCallback(
    (id: string) => {
      setActiveSideTab(id as SidePanelId);
      if (sideContentCollapsedRef.current) {
        applySidePanelCollapsed(false);
      }
    },
    [applySidePanelCollapsed],
  );

  const handleSideTabClick = useCallback(
    (_tabId: string, wasActive: boolean) => {
      if (wasActive) {
        applySidePanelCollapsed(!sideContentCollapsedRef.current);
      }
    },
    [applySidePanelCollapsed],
  );

  useEffect(() => {
    if (!sideTabs.some((item) => item.id === activeSideTab)) {
      setActiveSideTab((sideTabs[0]?.id ?? defaultSideTab) as SidePanelId);
    }
  }, [activeSideTab, defaultSideTab, sideTabs]);

  const openTunnelTab = useCallback(() => {
    setActiveSideTab("tunnel");
    applySidePanelCollapsed(false);
  }, [applySidePanelCollapsed]);

  const requestSftp = useSshDetailNavigationStore((s) => s.requestSftp);
  const lastSyncedSftpCwdRef = useRef<string | null>(null);

  useEffect(() => {
    lastSyncedSftpCwdRef.current = null;
  }, [resource?.id, tabId]);

  useEffect(() => {
    if (!isRemoteSsh || !resource?.id || tab?.status !== "connected") return;
    const sftpPath = normalizeTerminalCwdForSftp(tab.session.cwd);
    if (!sftpPath) return;
    if (lastSyncedSftpCwdRef.current === sftpPath) return;
    lastSyncedSftpCwdRef.current = sftpPath;
    requestSftp(resource.id, sftpPath);
  }, [isRemoteSsh, resource?.id, tab?.status, tab?.session.cwd, requestSftp]);

  const wrapSidePanel = useCallback(
    (sideTabId: string, node: ReactNode) => {
      const spec = resolveSidePanelSpec(sideTabId);
      if (!spec) return node;
      return (
        <WorkspaceComponent
          componentType={spec.componentType}
          label={spec.label}
          props={spec.props}
          snapshotId={spec.snapshotId}
          className="advance-terminal-side-panel-root"
        >
          {node}
        </WorkspaceComponent>
      );
    },
    [resolveSidePanelSpec],
  );

  const renderSidePanel = useCallback(
    (panelId: string) => {
      if (panelId === "history") {
        return wrapSidePanel(
          "history",
          <TerminalHistoryPanel
            sessionId={tabId}
            sessionTitle={tab?.title}
            onRunCommand={paneProps?.onSendCommand}
          />,
        );
      }
      if (isLocal) {
        if (panelId === "files") {
          return wrapSidePanel("files", <LocalFilePanel />);
        }
        if (panelId === "monitor") {
          return wrapSidePanel("monitor", <AdvanceTerminalMonitorStack mode="local" />);
        }
        return null;
      }
      if (!resource) return null;
      if (panelId === "sftp") {
        return wrapSidePanel("sftp", <SftpPanel resourceId={resource.id} />);
      }
      if (panelId === "tunnel") {
        return wrapSidePanel("tunnel", <TunnelPanel activeResource={resource} />);
      }
      if (panelId === "processes") {
        return wrapSidePanel(
          "processes",
          <AdvanceTerminalMonitorStack
            mode="remote"
            resourceId={resource.id}
            enableTunnels
            onOpenTunnelTab={openTunnelTab}
          />,
        );
      }
      return null;
    },
    [isLocal, openTunnelTab, paneProps?.onSendCommand, resource, tab?.title, tabId, wrapSidePanel],
  );

  if (!paneProps) return null;

  const terminalPane = <TerminalTabPaneView {...paneProps} />;

  if (!isRemoteSsh && !isLocal) {
    return (
      <div className="advance-terminal advance-terminal--local">
        {terminalPane}
      </div>
    );
  }

  return (
    <div className="advance-terminal">
      <DockLayout direction="horizontal" className="advance-terminal-split">
        <DockPanel
          defaultSize="50%"
          minSize={sideContentCollapsed ? "0%" : "40%"}
          className="advance-terminal-main"
        >
          {terminalPane}
        </DockPanel>
        {!sideContentCollapsed ? <DockHandle direction="horizontal" /> : null}
        <DockPanel
          defaultSize="50%"
          minSize={SIDE_TAB_RAIL_PX}
          maxSize={sideContentCollapsed ? SIDE_TAB_RAIL_PX : "60%"}
          collapsible
          collapsedSize={SIDE_TAB_RAIL_PX}
          panelRef={sidePanelRef}
          className={`advance-terminal-side${sideContentCollapsed ? " advance-terminal-side--collapsed" : ""}`}
        >
          <DockableWorkspace
            key={`${tabId}-${isLocal ? "local" : "remote"}`}
            className="advance-terminal-side-dock"
            dockScope={`terminal-side-${tabId}`}
            tabs={sideTabs}
            activeTabId={activeSideTab}
            onActiveTabChange={handleSideTabChange}
            onTabClick={handleSideTabClick}
            onCloseTab={() => {}}
            savedLayout={sideLayoutRef.current}
            onSavedLayoutChange={handleSideLayoutChange}
            renderPanel={renderSidePanel}
            enableTabGroups={false}
            defaultHeaderPosition="right"
            disableTabsOverflowList
            scrollbars="native"
          />
        </DockPanel>
      </DockLayout>
    </div>
  );
}
