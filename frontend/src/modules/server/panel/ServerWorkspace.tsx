import { useMemo } from "react";
import { useI18n } from "../../../i18n";
import { usePersistedModuleTab } from "../../../hooks/usePersistedModuleTab";
import type { ServerEntry } from "./serverConnection";
import { ServerInstalledApps } from "./ServerInstalledApps";
import { ServerPanelProcessesTab } from "@/components/server";
import { ServerWebsitesTab } from "./tabs/ServerWebsitesTab";
import { ServerCertificatesTab } from "./tabs/ServerCertificatesTab";

export type ServerDetailTab =
  | "processes"
  | "apps"
  | "websites"
  | "certificates";

const DETAIL_TAB_DEFS = [
  { id: "processes", icon: "processes" as const },
  { id: "apps", icon: "apps" as const },
  { id: "websites", icon: "websites" as const },
  { id: "certificates", icon: "certificates" as const },
] as const;

export function ServerDetailTabContent({
  server,
  tab,
  selectedItemId,
}: {
  server: ServerEntry;
  tab: ServerDetailTab;
  selectedItemId?: string | null;
}) {
  return (
    <div className="server-content">
      {tab === "processes" && <ServerPanelProcessesTab server={server} />}
      {tab === "apps" && (
        <ServerInstalledApps server={server} embedded selectedAppUid={selectedItemId ?? undefined} />
      )}
      {tab === "websites" && (
        <ServerWebsitesTab server={server} selectedItemId={selectedItemId ?? undefined} />
      )}
      {tab === "certificates" && (
        <ServerCertificatesTab server={server} selectedItemId={selectedItemId ?? undefined} />
      )}
    </div>
  );
}

export function useServerDetailTabs(activeTab: ServerDetailTab) {
  const { t } = useI18n();

  return useMemo(() => {
    const labels: Record<ServerDetailTab, string> = {
      processes: t("server.tabs.processes"),
      apps: t("server.tabs.apps"),
      websites: t("server.tabs.websites"),
      certificates: t("server.tabs.certificates"),
    };
    return DETAIL_TAB_DEFS.map((item) => ({
      id: item.id,
      label: labels[item.id],
      icon: "icon" in item ? item.icon : undefined,
      active: activeTab === item.id,
    }));
  }, [activeTab, t]);
}

/** @deprecated 模块级顶栏 Tab 已迁移至每服务器 dock 内分段 Tab */
export type ServerWorkspaceTab = "monitor" | ServerDetailTab;

/** @deprecated 模块级顶栏 Tab 已迁移至每服务器 dock 内分段 Tab */
export function useServerWorkspaceTabs(activeTab: ServerWorkspaceTab) {
  const { t } = useI18n();

  return useMemo(
    () =>
      (
        [
          { id: "monitor", label: t("server.tabs.monitor"), icon: "monitor" as const },
          ...DETAIL_TAB_DEFS,
        ] as const
      ).map((item) => ({
        id: item.id,
        label: t(`server.tabs.${item.id}` as "server.tabs.monitor"),
        icon: "icon" in item ? item.icon : undefined,
        active: activeTab === item.id,
      })),
    [activeTab, t],
  );
}

/** @deprecated 使用 per-server `usePersistedModuleTab('server-panel-${id}', ...)` */
export function useServerWorkspaceTabState() {
  const validTabs: ServerWorkspaceTab[] = [
    "monitor",
    "processes",
    "apps",
    "websites",
    "certificates",
  ];
  return usePersistedModuleTab("server", "monitor", validTabs);
}
