/** 侧栏双击打开主机面板；默认常驻标签。`preview` 仅兼容旧会话数据。 */
export type HostDockOpenMode = "preview" | "permanent";

export type SshHostWorkspaceTab = {
  id: string;
  kind: "host";
  label: string;
  hostId: string;
  /** 单击预览 Tab，标题斜体显示，下次单击其他主机时内容被替换 */
  preview?: boolean;
};

/** 当前唯一的预览 Tab（单击打开、可被下一次单击替换） */
export function findPreviewDockTab(tabs: SshHostWorkspaceTab[]): SshHostWorkspaceTab | undefined {
  return tabs.find((tab) => tab.preview);
}

/** 查找已打开的指定主机 Tab */
export function findTabIdForHost(tabs: SshHostWorkspaceTab[], hostId: string): string | undefined {
  return tabs.find((tab) => tab.hostId === hostId)?.id;
}

export function makeHostTabId(): string {
  return `sshtab:${Date.now()}`;
}
