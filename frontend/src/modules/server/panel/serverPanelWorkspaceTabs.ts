/** 侧栏单击打开的临时预览 Tab；双击变为常驻（无 preview）。 */
export type ServerPanelDockOpenMode = "preview" | "permanent";

export type ServerPanelWorkspaceTab = {
  id: string;
  kind: "server";
  label: string;
  serverId: string;
  /** 单击预览 Tab，标题斜体显示，下次单击其他服务器时内容被替换 */
  preview?: boolean;
};

/** 当前唯一的预览 Tab */
export function findPreviewDockTab(
  tabs: ServerPanelWorkspaceTab[],
): ServerPanelWorkspaceTab | undefined {
  return tabs.find((tab) => tab.preview);
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
