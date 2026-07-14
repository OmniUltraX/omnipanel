/** 侧栏双击打开面板；默认常驻标签。`preview` 仅兼容旧会话数据。 */
export type ServerPanelDockOpenMode = "preview" | "permanent";

export type ServerPanelWorkspaceTab = {
  id: string;
  kind: "server";
  label: string;
  serverId: string;
  /** @deprecated 旧「单击预览」槽位；新打开固定为常驻（false/undefined） */
  preview?: boolean;
};

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
  return tabs.map((tab) => (tab.preview ? { ...tab, preview: false } : tab));
}

/** 查找已打开的指定服务器 Tab */
export function findTabIdForServer(
  tabs: ServerPanelWorkspaceTab[],
  serverId: string,
): string | undefined {
  return tabs.find((tab) => tab.serverId === serverId)?.id;
}

export function makeServerTabId(): string {
  return `srvtab:${Date.now()}`;
}
