import { useEffect, useState } from "react";
import { useI18n } from "../../../i18n";
import { usePersistedModuleTab } from "../../../hooks/usePersistedModuleTab";
import { cloudRegionLabel, type CloudAccount } from "./cloudForm";
import { CloudResourceTabPanel } from "./CloudResourceTabPanel";
import {
  CLOUD_RESOURCE_TABS,
  type CloudSidebarNavTarget,
} from "./cloudSidebarNav";

interface CloudDockPanelProps {
  account: CloudAccount;
  isActive: boolean;
  navTarget: CloudSidebarNavTarget | null;
}

export function CloudDockPanel({ account, isActive, navTarget }: CloudDockPanelProps) {
  const { t } = useI18n();
  const defaultRegion = account.regions[0] ?? "cn-hangzhou";
  const [activeRegion, setActiveRegion] = useState(defaultRegion);
  const [activeTab, setActiveTab] = usePersistedModuleTab(
    `cloud-resource-${account.id}`,
    "ecs",
    CLOUD_RESOURCE_TABS,
  );

  useEffect(() => {
    if (navTarget?.accountId !== account.id) return;
    if (navTarget.region) {
      setActiveRegion(navTarget.region);
    } else if (account.regions[0]) {
      setActiveRegion(account.regions[0]);
    }
  }, [account.id, account.regions, navTarget]);

  useEffect(() => {
    if (!account.regions.includes(activeRegion)) {
      setActiveRegion(account.regions[0] ?? "cn-hangzhou");
    }
  }, [account.regions, activeRegion]);

  if (!isActive) {
    return <div className="server-panel-tab-pane" aria-hidden />;
  }

  return (
    <div className="server-main">
      <div className="server-dock-panel cloud-dock-panel">
        <div className="server-dock-header" style={{ padding: "8px 12px" }}>
          <div style={{ fontWeight: 600 }}>
            {t(`server.cloud.providers.${account.provider}`)} · {account.name} ·{" "}
            {cloudRegionLabel(activeRegion)}
          </div>
        </div>
        <div className="server-dock-panel__tabs" role="tablist" aria-label={t("server.cloud.sidebar.title")}>
          {CLOUD_RESOURCE_TABS.map((tab) => (
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
