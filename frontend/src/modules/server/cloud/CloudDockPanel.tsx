import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../i18n";
import { usePersistedModuleTab } from "../../../hooks/usePersistedModuleTab";
import { type CloudAccount } from "./cloudForm";
import { CloudResourceTabPanel } from "./CloudResourceTabPanel";
import {
  type CloudResourceTab,
  type CloudSidebarNavTarget,
} from "./cloudSidebarNav";
import { cloudTabsForProvider } from "../../cloud/cloudCapabilities";
import {
  fallbackCloudRegions,
  loadCloudAccountRegions,
  cloudRegionRowLabel,
} from "./cloudRegionDiscovery";
import type { CloudRegion } from "../../../ipc/bindings";

interface CloudDockPanelProps {
  account: CloudAccount;
  isActive: boolean;
  navTarget: CloudSidebarNavTarget | null;
}

export function CloudDockPanel({ account, isActive, navTarget }: CloudDockPanelProps) {
  const { t } = useI18n();
  const tabs = cloudTabsForProvider(account.provider);
  const [liveRegions, setLiveRegions] = useState<CloudRegion[] | null>(null);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    void loadCloudAccountRegions(account.id)
      .then((list) => {
        if (!cancelled && list.length > 0) setLiveRegions(list);
      })
      .catch(() => {
        if (!cancelled) setLiveRegions(null);
      });
    return () => {
      cancelled = true;
    };
  }, [account.id, isActive]);

  const regionRows = useMemo(() => {
    if (liveRegions && liveRegions.length > 0) return liveRegions;
    return fallbackCloudRegions(account.regions);
  }, [account.regions, liveRegions]);
  const regionIds = useMemo(() => regionRows.map((row) => row.regionId), [regionRows]);
  const defaultRegion = regionIds[0] ?? account.regions[0] ?? "cn-hangzhou";
  const [activeRegion, setActiveRegion] = useState(defaultRegion);
  const [activeTab, setActiveTab] = usePersistedModuleTab(
    `cloud-resource-${account.id}`,
    (tabs[0] ?? "ecs") as CloudResourceTab,
    tabs,
  );

  useEffect(() => {
    if (navTarget?.accountId !== account.id) return;
    if (navTarget.region) {
      setActiveRegion(navTarget.region);
    }
  }, [account.id, navTarget]);

  useEffect(() => {
    if (regionIds.length === 0) return;
    if (!regionIds.includes(activeRegion)) {
      setActiveRegion(regionIds[0] ?? "cn-hangzhou");
    }
  }, [activeRegion, regionIds]);

  if (!isActive) {
    return <div className="server-panel-tab-pane" aria-hidden />;
  }

  return (
    <div className="server-main">
      <div className="server-dock-panel cloud-dock-panel">
        <div className="server-dock-header" style={{ padding: "8px 12px" }}>
          <div style={{ fontWeight: 600 }}>
            {t(`server.cloud.providers.${account.provider}`)} · {account.name} ·{" "}
            {cloudRegionRowLabel(
              regionRows.find((row) => row.regionId === activeRegion) ?? {
                regionId: activeRegion,
                localName: "",
                hasEcs: false,
                hasSwas: false,
              },
            )}
          </div>
        </div>
        <div className="server-dock-panel__tabs" role="tablist" aria-label={t("server.cloud.sidebar.title")}>
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={activeTab === tab}
              className={`server-dock-panel__tab${activeTab === tab ? " is-active" : ""}`}
              onClick={() => setActiveTab(tab)}
            >
              <span className="server-dock-panel__tab-label">{t(`server.cloud.tabs.${tab}`)}</span>
            </button>
          ))}
        </div>
        <div className="server-dock-panel__tab-body">
          <CloudResourceTabPanel
            account={account}
            region={activeRegion}
            tab={activeTab}
            active={isActive}
          />
        </div>
      </div>
    </div>
  );
}
