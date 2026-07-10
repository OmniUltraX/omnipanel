import { useCallback, useEffect, useMemo, useRef } from "react";
import { ModuleSegmentDock } from "../../../components/dock";
import { usePersistedModuleTab } from "../../../hooks/usePersistedModuleTab";
import type { ServerEntry } from "./serverConnection";
import { ServerMonitorTab } from "@/components/server";
import {
  ServerDetailTabContent,
  useServerDetailTabs,
  type ServerDetailTab,
} from "./ServerWorkspace";
import type { ServerSidebarNavTarget } from "./serverSidebarNav";

interface ServerDockPanelProps {
  server: ServerEntry;
  /** 当前服务器 dock 面板处于激活态 */
  isActive: boolean;
  /** 模块路由可见且未挂起 */
  moduleLive: boolean;
  navTarget?: ServerSidebarNavTarget | null;
}

const DETAIL_TABS: ServerDetailTab[] = [
  "processes",
  "apps",
  "websites",
  "certificates",
];

export function ServerDockPanel({ server, isActive, moduleLive, navTarget = null }: ServerDockPanelProps) {
  const [detailTab, setDetailTab] = usePersistedModuleTab(
    `server-panel-${server.id}`,
    "processes",
    DETAIL_TABS,
  );
  const segmentTabs = useServerDetailTabs(detailTab);
  const navAppliedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!navTarget || !isActive || !navTarget.detailTab) return;
    const signature = `${navTarget.serverId}:${navTarget.detailTab}:${navTarget.itemId ?? ""}`;
    if (navAppliedRef.current === signature) return;
    navAppliedRef.current = signature;
    setDetailTab(navTarget.detailTab);
  }, [isActive, navTarget, setDetailTab]);

  const selectedItemId =
    navTarget?.detailTab === detailTab ? (navTarget.itemId ?? null) : null;

  const monitorActive = moduleLive && isActive;
  const detailActive = moduleLive && isActive;

  const renderDetailPanel = useCallback(
    (tabId: string) => {
      if (!detailActive) {
        return <div className="server-panel-tab-pane" aria-hidden />;
      }
      return (
        <ServerDetailTabContent
          server={server}
          tab={tabId as ServerDetailTab}
          selectedItemId={selectedItemId}
        />
      );
    },
    [detailActive, selectedItemId, server],
  );

  const dockTabs = useMemo(
    () =>
      segmentTabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        icon: tab.icon,
        panelType: `server-${tab.id}`,
      })),
    [segmentTabs],
  );

  return (
    <div className="server-dock-panel">
      <div className="server-dock-panel__monitor">
        <ServerMonitorTab server={server} active={monitorActive} />
      </div>
      <ModuleSegmentDock
        className="server-workspace-dock"
        variant="function"
        windowControl={false}
        enabled={detailActive}
        tabs={dockTabs}
        activeTabId={detailTab}
        onActiveTabChange={(id) => setDetailTab(id as ServerDetailTab)}
        renderPanel={renderDetailPanel}
        dockScope={`server-detail-${server.id}`}
        panelContentKey={detailActive ? server.id : `${server.id}-idle`}
      />
    </div>
  );
}
