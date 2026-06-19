import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useI18n } from "@/i18n";
import { TerminalTabPaneView } from "./TerminalPaneView";
import { AdvanceTerminalMonitorStack } from "./AdvanceTerminalMonitorStack";
import { useTerminalTabDockPane } from "./useTerminalTabDockPane";

type LocalSidePanelId = "files" | "monitor";
type RemoteSidePanelId = "sftp" | "tunnel" | "processes";
type SidePanelId = LocalSidePanelId | RemoteSidePanelId;

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
    if (isLocal) {
      return [
        {
          id: "files",
          label: t("terminal.sideTabs.files"),
          panelType: "terminal-side",
          closable: false,
        },
        {
          id: "monitor",
          label: t("terminal.sideTabs.monitor"),
          panelType: "terminal-side",
          closable: false,
        },
      ];
    }
    return [
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
      {
        id: "processes",
        label: t("ssh.detailTabs.processes"),
        panelType: "terminal-side",
        closable: false,
      },
    ];
  }, [isLocal, t]);

  const defaultSideTab = isLocal ? "files" : "sftp";
  const [activeSideTab, setActiveSideTab] = useState<SidePanelId>(defaultSideTab);
  /** 仅用 ref 持久化布局，避免 savedLayout=null 时 DockableWorkspace 清空已创建的面板 */
  const sideLayoutRef = useRef<SerializedDockview | null>(null);
  const handleSideLayoutChange = useCallback((layout: SerializedDockview | null) => {
    sideLayoutRef.current = layout;
  }, []);

  useEffect(() => {
    if (!sideTabs.some((tab) => tab.id === activeSideTab)) {
      setActiveSideTab((sideTabs[0]?.id ?? defaultSideTab) as SidePanelId);
    }
  }, [activeSideTab, defaultSideTab, sideTabs]);

  const openTunnelTab = useCallback(() => {
    setActiveSideTab("tunnel");
  }, []);

  const renderSidePanel = useCallback(
    (panelId: string) => {
      if (isLocal) {
        if (panelId === "files") return <LocalFilePanel />;
        if (panelId === "monitor") {
          return <AdvanceTerminalMonitorStack mode="local" />;
        }
        return null;
      }
      if (!resource) return null;
      if (panelId === "sftp") return <SftpPanel resourceId={resource.id} />;
      if (panelId === "tunnel") return <TunnelPanel activeResource={resource} />;
      if (panelId === "processes") {
        return (
          <AdvanceTerminalMonitorStack
            mode="remote"
            resourceId={resource.id}
            enableTunnels
            onOpenTunnelTab={openTunnelTab}
          />
        );
      }
      return null;
    },
    [isLocal, resource, openTunnelTab],
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
          minSize="40%"
          className="advance-terminal-main"
        >
          {terminalPane}
        </DockPanel>
        <DockHandle direction="horizontal" />
        <DockPanel
          defaultSize="50%"
          minSize="20%"
          maxSize="60%"
          className="advance-terminal-side"
        >
          <DockableWorkspace
            key={`${tabId}-${isLocal ? "local" : "remote"}`}
            className="advance-terminal-side-dock"
            tabs={sideTabs}
            activeTabId={activeSideTab}
            onActiveTabChange={(id) => setActiveSideTab(id as SidePanelId)}
            onCloseTab={() => {}}
            savedLayout={null}
            onSavedLayoutChange={handleSideLayoutChange}
            renderPanel={renderSidePanel}
            enableTabGroups={false}
            defaultHeaderPosition="top"
          />
        </DockPanel>
      </DockLayout>
    </div>
  );
}
