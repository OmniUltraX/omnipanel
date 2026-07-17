import { useEffect } from "react";
import { useI18n } from "@/i18n";
import { usePersistedModuleTab } from "@/hooks/usePersistedModuleTab";
import { ServerMonitorTab } from "@/components/server";
import type { ServerEntry } from "./serverConnection";
import type { ServerDetailTab, ServerSidebarNavTarget } from "./serverSidebarNav";
import { ServerTreeIcon } from "./serverTreeIcons";
import { ServerAppsTab } from "./tabs/ServerAppsTab";
import { ServerWebsitesTab } from "./tabs/ServerWebsitesTab";
import { ServerCertificatesTab } from "./tabs/ServerCertificatesTab";
import { ServerCronjobsTab } from "./tabs/ServerCronjobsTab";

const DETAIL_TABS = ["apps", "websites", "certificates", "cronjobs"] as const satisfies readonly ServerDetailTab[];

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
  const monitorActive = moduleLive && isActive;
  const detailActive = moduleLive && isActive;
  const selectedItemId =
    navTarget?.serverId === server.id ? (navTarget.itemId ?? null) : null;

  const [detailTab, setDetailTab] = usePersistedModuleTab(
    `server-panel-detail-${server.id}`,
    "apps",
    DETAIL_TABS,
  );

  useEffect(() => {
    if (navTarget?.serverId !== server.id || !navTarget.detailTab) return;
    if ((DETAIL_TABS as readonly string[]).includes(navTarget.detailTab)) {
      setDetailTab(navTarget.detailTab);
    }
  }, [navTarget, server.id, setDetailTab]);

  return (
    <div className="server-dock-panel">
      <div className="server-dock-panel__monitor">
        <ServerMonitorTab server={server} active={monitorActive} />
      </div>
      <div className="server-dock-panel__detail">
        <div className="server-dock-panel__tabs" role="tablist" aria-label={t("routes.server")}>
          {DETAIL_TABS.map((tab) => (
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
              {detailTab === "apps" ? <ServerAppsTab server={server} /> : null}
              {detailTab === "websites" ? (
                <ServerWebsitesTab server={server} selectedItemId={selectedItemId} />
              ) : null}
              {detailTab === "certificates" ? <ServerCertificatesTab server={server} /> : null}
              {detailTab === "cronjobs" ? <ServerCronjobsTab server={server} /> : null}
            </div>
          ) : (
            <div className="server-panel-tab-pane" aria-hidden />
          )}
        </div>
      </div>
    </div>
  );
}
