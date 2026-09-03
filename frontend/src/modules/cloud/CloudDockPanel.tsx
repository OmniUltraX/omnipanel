import { CloudAccountOverview } from "./CloudAccountOverview";
import { CloudResourceListPanel } from "./CloudResourceListPanel";
import { CloudResourceDetailPanel } from "./CloudResourceDetailPanel";
import type { CloudAccount } from "./cloudForm";
import type { CloudWorkspaceTab } from "./cloudWorkspaceTabs";

export function CloudDockPanel({
  tab,
  account,
  selectedRegions,
  inspectorRowId,
  onOpenCapability,
  onSelectRow,
  onOpenRow,
}: {
  tab: CloudWorkspaceTab;
  account: CloudAccount;
  selectedRegions: string[];
  inspectorRowId: string | null;
  onOpenCapability: (capability: string) => void;
  onSelectRow: (capability: string, resourceId: string, regionId: string) => void;
  onOpenRow: (capability: string, resourceId: string, regionId: string) => void;
}) {
  if (tab.kind === "account") {
    return (
      <CloudAccountOverview
        account={account}
        selectedRegions={selectedRegions}
        onOpenCapability={(capability) => onOpenCapability(capability)}
        onOpenResource={(capability, resourceId, regionId) => onOpenRow(capability, resourceId, regionId)}
      />
    );
  }
  if (tab.kind === "resources") {
    return (
      <CloudResourceListPanel
        account={account}
        capability={tab.capability}
        selectedRegions={selectedRegions}
        selectedRowId={inspectorRowId}
        onSelectRow={(row) => onSelectRow(tab.capability, row.id, row.regionId ?? "")}
        onOpenRow={(row) => onOpenRow(tab.capability, row.id, row.regionId ?? "")}
      />
    );
  }
  return (
    <CloudResourceDetailPanel
      account={account}
      capability={tab.capability}
      resourceId={tab.resourceId}
      regionId={tab.regionId}
    />
  );
}
