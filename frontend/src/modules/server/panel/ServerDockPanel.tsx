import { useEffect, useMemo } from "react";
import { useI18n } from "@/i18n";
import { usePersistedModuleTab } from "@/hooks/usePersistedModuleTab";
import { ServerMonitorTab } from "@/components/server";
import { usePluginRuntimeStore } from "@/stores/pluginRuntimeStore";
import type { ServerEntry } from "./serverConnection";
import type { ServerSidebarNavTarget } from "./serverSidebarNav";
import { ServerTreeIcon } from "./serverTreeIcons";
import { listPanelDockTabs, type PanelDockTabId } from "./panelTabIds";
import { PANEL_DOCK_TAB_SLOTS } from "./panelTabSlots";
import { ServerWebsitesTab } from "./tabs/ServerWebsitesTab";

interface ServerDockPanelProps {
  server: ServerEntry;
  /** 当前服务器 dock 面板处于激活态 */
  isActive: boolean;
  /** 模块路由可见且未挂起 */
  moduleLive: boolean;
  navTarget?: ServerSidebarNavTarget | null;
}

export function ServerDockPanel({ server, isActive, moduleLive, navTarget = null }: ServerDockPanelProps) {
  const { t } = useI18n();
  const pluginItems = usePluginRuntimeStore((s) => s.items);
  const monitorActive = moduleLive && isActive;
  const detailActive = moduleLive && isActive;
  const selectedItemId =
    navTarget?.serverId === server.id ? (navTarget.itemId ?? null) : null;

  const visibleTabs = useMemo(
    () => listPanelDockTabs(server.serviceType),
    [pluginItems, server.serviceType],
  );
  const defaultTab: PanelDockTabId = visibleTabs[0] ?? "apps";

  const [detailTab, setDetailTab] = usePersistedModuleTab(
    `server-panel-detail-${server.id}`,
    defaultTab,
    visibleTabs.length > 0 ? visibleTabs : (["apps"] as const satisfies readonly PanelDockTabId[]),
  );

  useEffect(() => {
    if (navTarget?.serverId !== server.id || !navTarget.detailTab) return;
    if (visibleTabs.includes(navTarget.detailTab)) {
      setDetailTab(navTarget.detailTab);
    }
  }, [navTarget, server.id, setDetailTab, visibleTabs]);

  const ActiveTab = PANEL_DOCK_TAB_SLOTS[detailTab];

  return (
    <div className="server-dock-panel">
      <div className="server-dock-panel__monitor">
        <ServerMonitorTab server={server} active={monitorActive} />
      </div>
      <div className="server-dock-panel__detail">
        <div className="server-dock-panel__tabs" role="tablist" aria-label={t("routes.server")}>
          {visibleTabs.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={detailTab === tab}
              className={`server-dock-panel__tab${detailTab === tab ? " is-active" : ""}`}
              onClick={() => setDetailTab(tab)}
            >
              <span className="server-dock-panel__tab-icon" aria-hidden>
                <ServerTreeIcon kind={tab} />
              </span>
              <span className="server-dock-panel__tab-label">{t(`server.tabs.${tab}`)}</span>
            </button>
          ))}
        </div>
        <div className="server-dock-panel__tab-body">
          {detailActive ? (
            <div className="server-content">
              {detailTab === "websites" ? (
                <ServerWebsitesTab server={server} selectedItemId={selectedItemId} />
              ) : ActiveTab ? (
                <ActiveTab server={server} />
              ) : null}
            </div>
          ) : (
            <div className="server-panel-tab-pane" aria-hidden />
          )}
        </div>
      </div>
    </div>
  );
}
