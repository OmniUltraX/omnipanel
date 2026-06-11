import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../i18n";
import type { ServerEntry } from "./serverConnection";
import { ServerInstalledApps } from "./ServerInstalledApps";
import { ServerMonitorTab } from "./tabs/ServerMonitorTab";
import { ServerProcessesTab } from "./tabs/ServerProcessesTab";
import { ServerWebsitesTab } from "./tabs/ServerWebsitesTab";
import { ServerDatabasesTab } from "./tabs/ServerDatabasesTab";
import { ServerCertificatesTab } from "./tabs/ServerCertificatesTab";
import { ServerCronjobsTab } from "./tabs/ServerCronjobsTab";
import { ServerLogsTab } from "./tabs/ServerLogsTab";

export type ServerWorkspaceTab =
  | "monitor"
  | "processes"
  | "apps"
  | "websites"
  | "databases"
  | "certificates"
  | "cronjobs"
  | "logs";

interface ServerWorkspaceProps {
  server: ServerEntry;
  tab: ServerWorkspaceTab;
}

export function ServerWorkspace({ server, tab }: ServerWorkspaceProps) {
  return (
    <div className="server-workspace">
      <div className="server-workspace-content">
        <div className="server-content">
          {tab === "monitor" && <ServerMonitorTab server={server} />}
          {tab === "processes" && <ServerProcessesTab server={server} />}
          {tab === "apps" && <ServerInstalledApps server={server} embedded />}
          {tab === "websites" && <ServerWebsitesTab server={server} />}
          {tab === "databases" && <ServerDatabasesTab server={server} />}
          {tab === "certificates" && <ServerCertificatesTab server={server} />}
          {tab === "cronjobs" && <ServerCronjobsTab server={server} />}
          {tab === "logs" && <ServerLogsTab server={server} />}
        </div>
      </div>
    </div>
  );
}

export function useServerWorkspaceTabs(activeTab: ServerWorkspaceTab) {
  const { t } = useI18n();

  return useMemo(
    () =>
      (
        [
          { id: "monitor", label: t("server.tabs.monitor"), icon: "monitor" as const },
          { id: "processes", label: t("server.tabs.processes"), icon: "processes" as const },
          { id: "apps", label: t("server.tabs.apps"), icon: "services" as const },
          { id: "websites", label: t("server.tabs.websites") },
          { id: "databases", label: t("server.tabs.databases") },
          { id: "certificates", label: t("server.tabs.certificates") },
          { id: "cronjobs", label: t("server.tabs.cronjobs") },
          { id: "logs", label: t("server.tabs.logs"), icon: "logs" as const },
        ] as const
      ).map((item) => ({
        id: item.id,
        label: item.label,
        icon: "icon" in item ? item.icon : undefined,
        active: activeTab === item.id,
      })),
    [activeTab, t],
  );
}

export function useServerWorkspaceTabState(serverId: string | null) {
  const [tab, setTab] = useState<ServerWorkspaceTab>("monitor");

  useEffect(() => {
    setTab("monitor");
  }, [serverId]);

  return [tab, setTab] as const;
}
