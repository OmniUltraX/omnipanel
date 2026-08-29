export type CloudDockOpenMode = "preview" | "permanent";

export type CloudAccountPanelTab = {
  id: string;
  kind: "account";
  accountId: string;
  preview?: boolean;
};

export type CloudResourcesPanelTab = {
  id: string;
  kind: "resources";
  accountId: string;
  capability: string;
  preview?: boolean;
};

export type CloudResourcePanelTab = {
  id: string;
  kind: "resource";
  accountId: string;
  capability: string;
  resourceId: string;
  regionId: string;
  preview?: boolean;
};

export type CloudWorkspaceTab =
  | CloudAccountPanelTab
  | CloudResourcesPanelTab
  | CloudResourcePanelTab;

export type CloudSidebarNavTarget =
  | { kind: "account"; accountId: string }
  | { kind: "capability"; accountId: string; capability: string }
  | {
      kind: "resource";
      accountId: string;
      capability: string;
      resourceId: string;
      regionId?: string;
    };

export function makeCloudAccountTabId(accountId: string): string {
  return `cloud-acc:${accountId}`;
}

export function makeCloudResourcesTabId(accountId: string, capability: string): string {
  return `cloud-list:${accountId}:${capability}`;
}

export function makeCloudResourceTabId(
  accountId: string,
  capability: string,
  resourceId: string,
): string {
  return `cloud-item:${accountId}:${capability}:${resourceId}`;
}

export function makeCloudTreeKey(target: CloudSidebarNavTarget): string {
  if (target.kind === "account") return `cloud:${target.accountId}`;
  if (target.kind === "capability") return `cloud:${target.accountId}:${target.capability}`;
  return `cloud:${target.accountId}:${target.capability}:${target.resourceId}`;
}

export function findPreviewDockTab(tabs: CloudWorkspaceTab[]): CloudWorkspaceTab | undefined {
  return tabs.find((tab) => tab.preview);
}

export function findTabIdForAccount(tabs: CloudWorkspaceTab[], accountId: string): string | undefined {
  return tabs.find((tab) => tab.kind === "account" && tab.accountId === accountId)?.id;
}

export function findTabIdForResources(
  tabs: CloudWorkspaceTab[],
  accountId: string,
  capability: string,
): string | undefined {
  return tabs.find(
    (tab) => tab.kind === "resources" && tab.accountId === accountId && tab.capability === capability,
  )?.id;
}

export function findTabIdForResource(
  tabs: CloudWorkspaceTab[],
  accountId: string,
  capability: string,
  resourceId: string,
): string | undefined {
  return tabs.find(
    (tab) =>
      tab.kind === "resource" &&
      tab.accountId === accountId &&
      tab.capability === capability &&
      tab.resourceId === resourceId,
  )?.id;
}

export function sanitizeCloudDockTabs(tabs: CloudWorkspaceTab[]): CloudWorkspaceTab[] {
  return tabs.filter((tab) => {
    const kind = (tab as { kind?: string }).kind;
    return kind === "account" || kind === "resources" || kind === "resource";
  });
}

export function capabilityHasDeclaredAction(
  actions: { id: string }[] | undefined,
  actionId: string,
): boolean {
  return Boolean(actions?.some((item) => item.id === actionId));
}
