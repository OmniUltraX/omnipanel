/** 侧栏双击打开面板；默认常驻标签。`preview` 仅兼容旧会话数据，新打开不再走预览槽。 */
export type DockerConnectionDockOpenMode = "preview" | "permanent";

export type DockerConnectionPanelTab = {
  id: string;
  kind: "connection";
  label: string;
  connectionId: string;
  /** @deprecated 旧「单击预览」槽位；新打开固定为常驻（false/undefined） */
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

export type DockerImagesPanelTab = {
  id: string;
  kind: "images";
  label: string;
  connectionId: string;
  preview?: boolean;
};

export type DockerNetworksPanelTab = {
  id: string;
  kind: "networks";
  label: string;
  connectionId: string;
  preview?: boolean;
};

export type DockerVolumesPanelTab = {
  id: string;
  kind: "volumes";
  label: string;
  connectionId: string;
  preview?: boolean;
};

export type DockerComposePanelTab = {
  id: string;
  kind: "compose";
  label: string;
  connectionId: string;
  composeProject: string;
  preview?: boolean;
};

export type DockerConnectionWorkspaceTab =
  | DockerConnectionPanelTab
  | DockerContainerPanelTab
  | DockerImagesPanelTab
  | DockerNetworksPanelTab
  | DockerVolumesPanelTab
  | DockerComposePanelTab;

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
  return tabs.find((tab) => tab.kind === "connection" && tab.connectionId === connectionId)?.id;
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

/** 查找已打开的指定连接镜像列表 Tab */
export function findTabIdForImages(
  tabs: DockerConnectionWorkspaceTab[],
  connectionId: string,
): string | undefined {
  return tabs.find((tab) => tab.kind === "images" && tab.connectionId === connectionId)?.id;
}

/** 查找已打开的指定连接网络列表 Tab */
export function findTabIdForNetworks(
  tabs: DockerConnectionWorkspaceTab[],
  connectionId: string,
): string | undefined {
  return tabs.find((tab) => tab.kind === "networks" && tab.connectionId === connectionId)?.id;
}

/** 查找已打开的指定连接卷浏览 Tab */
export function findTabIdForVolumes(
  tabs: DockerConnectionWorkspaceTab[],
  connectionId: string,
): string | undefined {
  return tabs.find((tab) => tab.kind === "volumes" && tab.connectionId === connectionId)?.id;
}

/** 查找已打开的指定 Compose 项目 Tab */
export function findTabIdForCompose(
  tabs: DockerConnectionWorkspaceTab[],
  connectionId: string,
  composeProject: string,
): string | undefined {
  const normalized = composeProject.trim();
  return tabs.find(
    (tab) =>
      tab.kind === "compose" &&
      tab.connectionId === connectionId &&
      tab.composeProject.trim() === normalized,
  )?.id;
}

export function makeConnectionTabId(): string {
  return `dockconn:${Date.now()}`;
}

export function makeContainerTabId(): string {
  return `dockctr:${Date.now()}`;
}

export function makeImagesTabId(): string {
  return `dockimg:${Date.now()}`;
}

export function makeNetworksTabId(): string {
  return `docknet:${Date.now()}`;
}

export function makeVolumesTabId(): string {
  return `dockvol:${Date.now()}`;
}

export function makeComposeTabId(): string {
  return `dockcmp:${Date.now()}`;
}

export function isDockerContainerTab(
  tab: DockerConnectionWorkspaceTab,
): tab is DockerContainerPanelTab {
  return tab.kind === "container";
}

export function isDockerImagesTab(
  tab: DockerConnectionWorkspaceTab,
): tab is DockerImagesPanelTab {
  return tab.kind === "images";
}

export function isDockerNetworksTab(
  tab: DockerConnectionWorkspaceTab,
): tab is DockerNetworksPanelTab {
  return tab.kind === "networks";
}

export function isDockerVolumesTab(
  tab: DockerConnectionWorkspaceTab,
): tab is DockerVolumesPanelTab {
  return tab.kind === "volumes";
}

export function isDockerComposeTab(
  tab: DockerConnectionWorkspaceTab,
): tab is DockerComposePanelTab {
  return tab.kind === "compose";
}

/** 过滤持久化中已废弃的服务组 Tab，并将旧预览 Tab 提升为常驻。 */
export function sanitizeDockerDockTabs(
  tabs: DockerConnectionWorkspaceTab[],
): DockerConnectionWorkspaceTab[] {
  return tabs
    .filter((tab) => {
      const kind = (tab as { kind?: string }).kind;
      return kind !== "service-group";
    })
    .map((tab) => (tab.preview ? { ...tab, preview: false } : tab));
}
