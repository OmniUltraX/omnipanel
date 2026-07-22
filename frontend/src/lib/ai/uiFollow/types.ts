/** AI 操作跟随：结构化导航意图（只导航/展示，不替代写操作确认）。 */
export type FollowModuleKey =
  | "terminal"
  | "database"
  | "docker"
  | "ssh"
  | "files"
  | "server"
  | "knowledge"
  | "tasks"
  | "protocol"
  | "workflow";

export type UiFollowIntent =
  | { type: "focusModule"; module: FollowModuleKey }
  | { type: "openConnection"; module: FollowModuleKey; resourceId: string }
  | { type: "selectContainer"; connectionId: string; containerId: string }
  | { type: "openSqlDraft"; connectionId: string; database?: string | null; sql?: string | null }
  | { type: "selectTable"; connectionId: string; database: string; table: string }
  | { type: "selectDatabase"; connectionId: string; database: string }
  | { type: "revealTerminal"; sessionId: string; blockId?: string }
  | { type: "openFile"; connectionId: string; path: string }
  | { type: "switchWorkspace"; workspaceId: string }
  | { type: "selectServer"; serverId: string; kind?: string | null }
  | { type: "openDocument"; entryId: string; mode?: "permanent" | "preview" }
  | { type: "revealSftpPath"; resourceId: string; path: string }
  | { type: "openResourceProfile"; resourceType: string; resourceId: string };

/** 从 intent 提取目标模块（用于 registry 分发和 pending 队列路由）。 */
export function resolveIntentModule(intent: UiFollowIntent): FollowModuleKey | null {
  switch (intent.type) {
    case "focusModule":
      return intent.module;
    case "openConnection":
      return intent.module;
    case "selectContainer":
      return "docker";
    case "openSqlDraft":
    case "selectTable":
    case "selectDatabase":
      return "database";
    case "revealTerminal":
      return "terminal";
    case "openFile":
      return "files";
    case "switchWorkspace":
      return null;
    case "selectServer":
      return "server";
    case "openDocument":
      return "knowledge";
    case "revealSftpPath":
      return "ssh";
    case "openResourceProfile":
      return "knowledge";
    default:
      return null;
  }
}
