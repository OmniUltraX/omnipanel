/** 侧栏单击打开的临时预览 Tab；双击变为常驻（无 preview）。 */
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
