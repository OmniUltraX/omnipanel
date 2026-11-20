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

/** 预览标签换资源时必须换成这条资源自己的 id，否则两条记录挤在同一个面板上。 */
export function canonicalCloudTabId(tab: CloudWorkspaceTab): string {
  if (tab.kind === "account") return makeCloudAccountTabId(tab.accountId);
  if (tab.kind === "resources") return makeCloudResourcesTabId(tab.accountId, tab.capability);
  return makeCloudResourceTabId(tab.accountId, tab.capability, tab.resourceId);
}

export function repairCloudDockTabs(tabs: CloudWorkspaceTab[]): CloudWorkspaceTab[] {
  const clean = sanitizeCloudDockTabs(tabs);
  const seen = new Set<string>();
  const out: CloudWorkspaceTab[] = [];
  let changed = clean.length !== tabs.length;
  for (const tab of clean) {
    const id = canonicalCloudTabId(tab);
    if (seen.has(id)) {
      changed = true;
      continue;
    }
    seen.add(id);
    if (id !== tab.id) {
      changed = true;
      out.push({ ...tab, id });
    } else {
      out.push(tab);
    }
  }
  return changed ? out : tabs;
}

export function capabilityHasDeclaredAction(
  actions: { id: string }[] | undefined,
  actionId: string,
): boolean {
  return Boolean(actions?.some((item) => item.id === actionId));
}
