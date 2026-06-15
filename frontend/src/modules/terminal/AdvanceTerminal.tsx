import { useCallback, useMemo, useState } from "react";
import { DockHandle, DockLayout, DockPanel } from "../../components/dock";
import { LocalFilePanel } from "../../components/files";
import { SftpPanel } from "../../components/sftp";
import { TunnelPanel } from "../../components/tunnel";
import { useI18n } from "../../i18n";
import { OverviewStatsCards } from "../server/ssh/components/detail/OverviewStatsCards";
import { ProcessListPanel } from "../server/ssh/components/detail/ProcessListPanel";
import { useSshOverview } from "../server/ssh/hooks/useSshOverview";
import type { DetailTab } from "../server/ssh/types";
import { TerminalTabPaneView } from "./TerminalPaneView";
import { useTerminalTabDockPane } from "./useTerminalTabDockPane";

type RemoteSideTab = "sftp" | "tunnel" | "processes";
type LocalSideTab = "files";
type SideTab = RemoteSideTab | LocalSideTab;

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

  const [sideTab, setSideTab] = useState<SideTab>(isLocal ? "files" : "sftp");

  const resourceId = isRemoteSsh && resource ? resource.id : null;
  const {
    phase,
    stats,
    processes,
    error,
    updatedAt,
    refreshing,
    refreshProcesses,
    refresh,
  } = useSshOverview(resourceId);

  const handleDetailTab = useCallback((detailTab: DetailTab) => {
    if (detailTab === "sftp") setSideTab("sftp");
    if (detailTab === "tunnels") setSideTab("tunnel");
  }, []);

  if (!paneProps) return null;

  const terminalPane = <TerminalTabPaneView {...paneProps} />;

  if (!isRemoteSsh && !isLocal) {
    return (
      <div className="advance-terminal advance-terminal--local">
        {terminalPane}
      </div>
    );
  }

  const sideTabs = isLocal ? (
    <button
      type="button"
      role="tab"
      aria-selected={sideTab === "files"}
      className={`advance-terminal-side-tab${sideTab === "files" ? " active" : ""}`}
      onClick={() => setSideTab("files")}
    >
      {t("terminal.sideTabs.files")}
    </button>
  ) : (
    <>
      <button
        type="button"
        role="tab"
        aria-selected={sideTab === "sftp"}
        className={`advance-terminal-side-tab${sideTab === "sftp" ? " active" : ""}`}
        onClick={() => setSideTab("sftp")}
      >
        {t("ssh.detailTabs.sftp")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={sideTab === "tunnel"}
        className={`advance-terminal-side-tab${sideTab === "tunnel" ? " active" : ""}`}
        onClick={() => setSideTab("tunnel")}
      >
        {t("ssh.detailTabs.tunnels")}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={sideTab === "processes"}
        className={`advance-terminal-side-tab${sideTab === "processes" ? " active" : ""}`}
        onClick={() => setSideTab("processes")}
      >
        {t("ssh.detailTabs.processes")}
      </button>
    </>
  );

  const sideBody = isLocal ? (
    sideTab === "files" && <LocalFilePanel />
  ) : (
    resource && (
      <>
        {sideTab === "sftp" && (
          <div className="advance-terminal-sftp-stack">
            <OverviewStatsCards
              embedded
              phase={phase}
              stats={stats}
              error={error}
              onRetry={() => refresh()}
            />
            <SftpPanel resourceId={resource.id} />
          </div>
        )}
        {sideTab === "tunnel" && <TunnelPanel activeResource={resource} />}
        {sideTab === "processes" && (
          <ProcessListPanel
            resourceId={resource.id}
            processes={processes}
            loading={refreshing}
            refreshing={refreshing}
            updatedAt={updatedAt}
            setDetailTab={handleDetailTab}
            onRefresh={refreshProcesses}
          />
        )}
      </>
    )
  );

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
          <div className="advance-terminal-side-tabs" role="tablist">
            {sideTabs}
          </div>
          <div className="advance-terminal-side-body" role="tabpanel">
            {sideBody}
          </div>
        </DockPanel>
      </DockLayout>
    </div>
  );
}
