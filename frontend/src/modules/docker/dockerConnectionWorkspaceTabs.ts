/** 侧栏单击打开的临时预览 Tab；双击变为常驻（无 preview）。 */
export type DockerConnectionDockOpenMode = "preview" | "permanent";

export type DockerConnectionPanelTab = {
  id: string;
  kind: "connection";
  label: string;
  connectionId: string;
  /** 单击预览 Tab，标题斜体显示，下次单击其他连接时内容被替换 */
  preview?: boolean;
};

export type DockerServiceGroupPanelTab = {
  id: string;
  kind: "service-group";
  label: string;
  connectionId: string;
  serviceGroupId: string;
  preview?: boolean;
};

export type DockerContainerPanelTab = {
  id: string;
  kind: "container";
  label: string;
  connectionId: string;
  containerId: string;
  preview?: boolean;
};

export type DockerConnectionWorkspaceTab =
  | DockerConnectionPanelTab
  | DockerServiceGroupPanelTab
  | DockerContainerPanelTab;

/** 当前唯一的预览 Tab */
export function findPreviewDockTab(
  tabs: DockerConnectionWorkspaceTab[],
): DockerConnectionWorkspaceTab | undefined {
  return tabs.find((tab) => tab.preview);
}

/** 查找已打开的指定连接 Tab（不含服务组 Tab） */
export function findTabIdForConnection(
  tabs: DockerConnectionWorkspaceTab[],
  connectionId: string,
): string | undefined {
  return tabs.find((tab) => tab.kind === "connection" && tab.connectionId === connectionId)?.id;
}

/** 查找已打开的指定服务组 Tab */
export function findTabIdForServiceGroup(
  tabs: DockerConnectionWorkspaceTab[],
  connectionId: string,
  serviceGroupId: string,
): string | undefined {
  return tabs.find(
    (tab) =>
      tab.kind === "service-group" &&
      tab.connectionId === connectionId &&
      tab.serviceGroupId === serviceGroupId,
  )?.id;
}

/** 查找已打开的指定容器 Tab */
export function findTabIdForContainer(
  tabs: DockerConnectionWorkspaceTab[],
  connectionId: string,
  containerId: string,
): string | undefined {
  const normalized = containerId.trim().toLowerCase();
  return tabs.find(
    (tab) =>
      tab.kind === "container" &&
      tab.connectionId === connectionId &&
      tab.containerId.trim().toLowerCase() === normalized,
  )?.id;
}

export function makeConnectionTabId(): string {
  return `dockconn:${Date.now()}`;
}

export function makeServiceGroupTabId(): string {
  return `docksvc:${Date.now()}`;
}

export function makeContainerTabId(): string {
  return `dockctr:${Date.now()}`;
}

export function isDockerServiceGroupTab(
  tab: DockerConnectionWorkspaceTab,
): tab is DockerServiceGroupPanelTab {
  return tab.kind === "service-group";
}

export function isDockerContainerTab(
  tab: DockerConnectionWorkspaceTab,
): tab is DockerContainerPanelTab {
  return tab.kind === "container";
}
