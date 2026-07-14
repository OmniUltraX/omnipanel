/** 侧栏双击打开面板；默认常驻标签。`preview` 仅兼容旧会话数据。 */
export type KnowledgeDockOpenMode = "preview" | "permanent";

export type KnowledgeWorkspaceTabKind = "document" | "chunks";

export type KnowledgeWorkspaceTab = {
  id: string;
  entryId: string;
  label: string;
  preview?: boolean;
  /** 默认 document；chunks 为向量化文本块视图 */
  kind?: KnowledgeWorkspaceTabKind;
};

export function findPreviewDockTab(
  tabs: KnowledgeWorkspaceTab[],
): KnowledgeWorkspaceTab | undefined {
  return tabs.find((tab) => tab.preview);
}

export function makeKnowledgeTabId(): string {
  return `kn-tab:${Date.now()}`;
}

export function tabMatchesEntry(tab: KnowledgeWorkspaceTab, entryId: string): boolean {
  return tab.entryId === entryId && (tab.kind ?? "document") === "document";
}

export function findTabIdForEntry(
  tabs: KnowledgeWorkspaceTab[],
  entryId: string,
): string | undefined {
  return tabs.find(
    (tab) => !tab.preview && tab.entryId === entryId && (tab.kind ?? "document") === "document",
  )?.id;
}

export function findTabIdForEntryChunks(
  tabs: KnowledgeWorkspaceTab[],
  entryId: string,
): string | undefined {
  return tabs.find(
    (tab) => !tab.preview && tab.entryId === entryId && tab.kind === "chunks",
  )?.id;
}

export function makeChunksTabLabel(documentTitle: string, chunksLabel: string): string {
  return `${documentTitle} · ${chunksLabel}`;
}
