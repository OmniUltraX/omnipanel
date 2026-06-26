/** 侧栏单击打开的临时预览 Tab；双击变为常驻（无 preview）。 */
export type DockerConnectionDockOpenMode = "preview" | "permanent";

export type DockerConnectionWorkspaceTab = {
  id: string;
  kind: "connection";
  label: string;
  connectionId: string;
  /** 单击预览 Tab，标题斜体显示，下次单击其他连接时内容被替换 */
  preview?: boolean;
};

/** 当前唯一的预览 Tab */
export function findPreviewDockTab(
  tabs: DockerConnectionWorkspaceTab[],
): DockerConnectionWorkspaceTab | undefined {
  return tabs.find((tab) => tab.preview);
}

/** 查找已打开的指定连接 Tab */
export function findTabIdForConnection(
  tabs: DockerConnectionWorkspaceTab[],
  connectionId: string,
): string | undefined {
  return tabs.find((tab) => tab.connectionId === connectionId)?.id;
}

export function makeConnectionTabId(): string {
  return `dockconn:${Date.now()}`;
}
