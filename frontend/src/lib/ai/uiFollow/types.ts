/** AI 操作跟随：结构化导航意图（只导航/展示，不替代写操作确认）。 */
export type UiFollowIntent =
  | { type: "focusModule"; module: "terminal" | "database" | "docker" | "ssh" | "files" | "server" | "knowledge" }
  | { type: "openConnection"; module: "database" | "docker" | "ssh" | "files"; resourceId: string }
  | { type: "selectContainer"; connectionId: string; containerId: string }
  | { type: "openSqlDraft"; connectionId: string; database?: string | null; sql?: string | null }
  | { type: "revealTerminal"; sessionId: string; blockId?: string }
  | { type: "openFile"; connectionId: string; path: string }
  | { type: "switchWorkspace"; workspaceId: string };
