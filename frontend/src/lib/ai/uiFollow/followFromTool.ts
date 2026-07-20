import { followAiIntent, followAiIntents } from "./index";
import type { UiFollowIntent } from "./types";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** 根据工具名与参数推导 Follow 意图（执行前调用）。 */
export function followIntentsForTool(
  toolName: string,
  args: Record<string, unknown>,
): UiFollowIntent[] {
  const connectionId =
    str(args.connection_id) ?? str(args.connectionId) ?? str(args.resource_id);
  const containerId = str(args.container_id) ?? str(args.containerId);
  const sessionId = str(args.session_id) ?? str(args.sessionId);
  const path = str(args.path);
  const sql = str(args.sql) ?? str(args.query);

  if (toolName.startsWith("omni_docker_")) {
    const intents: UiFollowIntent[] = [{ type: "focusModule", module: "docker" }];
    if (connectionId && containerId) {
      intents.push({ type: "selectContainer", connectionId, containerId });
    } else if (connectionId) {
      intents.push({ type: "openConnection", module: "docker", resourceId: connectionId });
    }
    return intents;
  }

  if (toolName.startsWith("omni_database_")) {
    const intents: UiFollowIntent[] = [{ type: "focusModule", module: "database" }];
    if (connectionId) {
      intents.push({
        type: "openSqlDraft",
        connectionId,
        database: str(args.database) ?? str(args.database_name),
        sql: toolName.includes("execute_sql") ? sql : null,
      });
    }
    return intents;
  }

  if (toolName.startsWith("omni_ssh_")) {
    const intents: UiFollowIntent[] = [{ type: "focusModule", module: "ssh" }];
    if (connectionId) {
      intents.push({ type: "openConnection", module: "ssh", resourceId: connectionId });
    }
    return intents;
  }

  if (toolName.startsWith("omni_files_")) {
    const intents: UiFollowIntent[] = [{ type: "focusModule", module: "files" }];
    if (connectionId && path) {
      intents.push({ type: "openFile", connectionId, path });
    } else if (connectionId) {
      intents.push({ type: "openConnection", module: "files", resourceId: connectionId });
    }
    return intents;
  }

  if (toolName === "omni_terminal_run_terminal_command" && sessionId) {
    return [{ type: "revealTerminal", sessionId }];
  }

  if (toolName.startsWith("omni_workspace_")) {
    const workspaceId = str(args.workspace_id) ?? str(args.id);
    if (toolName.includes("switch") && workspaceId) {
      return [{ type: "switchWorkspace", workspaceId }];
    }
  }

  return [];
}

export function applyUiFollowForTool(
  toolName: string,
  argsJson: string,
): void {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
  } catch {
    // ignore
  }
  const intents = followIntentsForTool(toolName, args);
  if (intents.length === 1) {
    followAiIntent(intents[0]!);
  } else if (intents.length > 1) {
    followAiIntents(intents);
  }
}
