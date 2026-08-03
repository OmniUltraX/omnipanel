/** 侧栏双击打开面板；默认常驻标签。`preview` 仅兼容旧会话数据。 */
export type ServerPanelDockOpenMode = "preview" | "permanent";

export type ServerPanelResourceKind = "websites" | "certificates" | "cronjobs";

export type ServerPanelWorkspaceTabKind = "server" | "cloud" | ServerPanelResourceKind;

export type ServerOverviewPanelTab = {
  id: string;
  kind: "server";
  label: string;
  serverId: string;
  /** @deprecated 旧「单击预览」槽位；新打开固定为常驻（false/undefined） */
  preview?: boolean;
};

export type CloudOverviewPanelTab = {
  id: string;
  kind: "cloud";
  label: string;
  serverId: string;
  preview?: boolean;
};

export type ServerWebsitesPanelTab = {
  id: string;
  kind: "websites";
  label: string;
  serverId: string;
  preview?: boolean;
};

export type ServerCertificatesPanelTab = {
  id: string;
  kind: "certificates";
  label: string;
  serverId: string;
  preview?: boolean;
};

export type ServerCronjobsPanelTab = {
  id: string;
  kind: "cronjobs";
  label: string;
  serverId: string;
  preview?: boolean;
};

export type ServerPanelWorkspaceTab =
  | ServerOverviewPanelTab
  | CloudOverviewPanelTab
  | ServerWebsitesPanelTab
  | ServerCertificatesPanelTab
  | ServerCronjobsPanelTab;

/**
 * 查找遗留的预览 Tab（新打开固定为常驻，此函数仅服务兼容路径）。
 */
export function findPreviewDockTab(
  tabs: ServerPanelWorkspaceTab[],
): ServerPanelWorkspaceTab | undefined {
  return tabs.find((tab) => tab.preview);
}

/** 将旧预览 Tab 提升为常驻。 */
export function sanitizeServerPanelDockTabs(
  tabs: ServerPanelWorkspaceTab[],
): ServerPanelWorkspaceTab[] {
  return tabs.map((tab) => {
    const kind = (tab as { kind?: string }).kind ?? "server";
    const normalized: ServerPanelWorkspaceTab = {
      ...tab,
      kind: isServerPanelWorkspaceTabKind(kind) ? kind : "server",
    };
    return normalized.preview ? { ...normalized, preview: false } : normalized;
  });
}

function isServerPanelWorkspaceTabKind(kind: string): kind is ServerPanelWorkspaceTabKind {
  return (
    kind === "server" ||
    kind === "cloud" ||
    kind === "websites" ||
    kind === "certificates" ||
    kind === "cronjobs"
  );
}

/** 查找已打开的服务器总览 Tab（监控 + 三 Tab） */
export function findTabIdForServer(
  tabs: ServerPanelWorkspaceTab[],
  serverId: string,
): string | undefined {
  return tabs.find((tab) => tab.kind === "server" && tab.serverId === serverId)?.id;
}

/** 查找已打开的云账户总览 Tab */
export function findTabIdForCloud(
  tabs: ServerPanelWorkspaceTab[],
  accountId: string,
): string | undefined {
  return tabs.find((tab) => tab.kind === "cloud" && tab.serverId === accountId)?.id;
}

/** 查找已打开的资源列表面板 Tab */
export function findTabIdForServerResource(
  tabs: ServerPanelWorkspaceTab[],
  serverId: string,
  kind: ServerPanelResourceKind,
): string | undefined {
  return tabs.find((tab) => tab.kind === kind && tab.serverId === serverId)?.id;
}

export function makeServerTabId(): string {
  return `srvtab:${Date.now()}`;
}

export function makeCloudTabId(): string {
  return `cloudtab:${Date.now()}`;
}

export function makeServerResourceTabId(kind: ServerPanelResourceKind): string {
  return `srv${kind}:${Date.now()}`;
}

export function isServerOverviewTab(
  tab: ServerPanelWorkspaceTab,
): tab is ServerOverviewPanelTab {
  return tab.kind === "server";
}

export function isCloudOverviewTab(
  tab: ServerPanelWorkspaceTab,
): tab is CloudOverviewPanelTab {
  return tab.kind === "cloud";
}

export function isServerResourceTab(
  tab: ServerPanelWorkspaceTab,
): tab is ServerWebsitesPanelTab | ServerCertificatesPanelTab | ServerCronjobsPanelTab {
  return tab.kind === "websites" || tab.kind === "certificates" || tab.kind === "cronjobs";
}

export function makeServerResourceTab(
  id: string,
  serverId: string,
  kind: ServerPanelResourceKind,
  preview: boolean,
): ServerPanelWorkspaceTab {
  return { id, kind, serverId, preview, label: "" };
}

export function makeCloudTab(
  id: string,
  accountId: string,
  preview: boolean,
): CloudOverviewPanelTab {
  return { id, kind: "cloud", serverId: accountId, preview, label: "" };
}
