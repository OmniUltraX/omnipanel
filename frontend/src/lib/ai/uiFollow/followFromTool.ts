/**
 * 工具→Follow意图映射 + 结果感知推断。
 *
 * 设计理念：
 * 1. 参数感知：从工具 args 提取 connection_id/path/sql 等定位信息
 * 2. 结果感知：从工具 result 提取新创建的资源（如 create_database 返回的库名）
 * 3. 工具语义映射：按工具名前缀 + 具体动作推断最佳意图
 *
 * 例：
 * - omni_database_execute_sql(args.sql) → openSqlDraft(sql)
 * - omni_database_create_database(result.database) → selectDatabase(database)
 * - omni_ssh_exec(args.command 含 "touch/echo > /cat >") → revealSftpPath(解析路径)
 * - omni_files_write(args.path) → openFile(path)
 * - omni_knowledge_create(result.id) → openDocument(id)
 */
import { followAiIntent, followAiIntents } from "./index";
import type { UiFollowIntent } from "./types";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** 安全解析 JSON 字符串（工具结果可能是 JSON 字符串或纯文本） */
function parseResult(result: string | null | undefined): Record<string, unknown> | null {
  if (!result) return null;
  try {
    const parsed = JSON.parse(result);
    if (parsed !== null && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 纯文本结果，无法提取结构化信息
  }
  return null;
}

/** 从 SSH command 中提取文件路径（touch/echo重定向/cat重定向/vim等） */
function extractFilePathFromCommand(command: string): string | null {
  // touch /path/to/file
  let m = command.match(/\btouch\s+([^\s;&|]+)/);
  if (m) return m[1]!;
  // echo "..." > /path 或 cat > /path
  m = command.match(/>\s*([^\s;&|]+)/);
  if (m) return m[1]!;
  // mkdir -p /path
  m = command.match(/\bmkdir\s+(?:-p\s+)?([^\s;&|]+)/);
  if (m) return m[1]!;
  return null;
}

/**
 * 根据工具名、参数和结果推导 Follow 意图。
 *
 * @param toolName 工具名
 * @param args 工具参数（已解析的对象）
 * @param result 工具执行结果（JSON 字符串或纯文本，可选）
 */
export function followIntentsForTool(
  toolName: string,
  args: Record<string, unknown>,
  result?: string | null,
): UiFollowIntent[] {
  const connectionId =
    str(args.connection_id) ?? str(args.connectionId) ?? str(args.resource_id);
  const containerId = str(args.container_id) ?? str(args.containerId);
  const sessionId = str(args.session_id) ?? str(args.sessionId);
  const path = str(args.path);
  const sql = str(args.sql) ?? str(args.query);
  const parsedResult = parseResult(result);

  // === 知识库工具 ===
  if (toolName.startsWith("omni_knowledge_")) {
    const intents: UiFollowIntent[] = [{ type: "focusModule", module: "knowledge" }];
    // 创建文档：从 result 提取新文档 id，打开它
    if (toolName.includes("create") && parsedResult) {
      const entryId = str(parsedResult.id) ?? str(parsedResult.entry_id);
      if (entryId) {
        intents.push({ type: "openDocument", entryId, mode: "permanent" });
      }
    }
    return intents;
  }

  // === 资源档案工具 ===
  if (toolName.startsWith("omni_resource_")) {
    const resourceType = str(args.resource_type) ?? str(parsedResult?.resource_type);
    const resourceId = str(args.resource_id) ?? str(parsedResult?.resource_id);
    if (resourceType && resourceId) {
      return [{ type: "openResourceProfile", resourceType, resourceId }];
    }
    return [{ type: "focusModule", module: "knowledge" }];
  }

  // === Skill 自我进化工具 ===
  if (toolName.startsWith("omni_skill_")) {
    return [{ type: "focusModule", module: "knowledge" }];
  }

  // === Docker 工具 ===
  if (toolName.startsWith("omni_docker_")) {
    const intents: UiFollowIntent[] = [{ type: "focusModule", module: "docker" }];
    if (connectionId && containerId) {
      intents.push({ type: "selectContainer", connectionId, containerId });
    } else if (connectionId) {
      intents.push({ type: "openConnection", module: "docker", resourceId: connectionId });
    }
    return intents;
  }

  // === 数据库工具 ===
  if (toolName.startsWith("omni_database_")) {
    const intents: UiFollowIntent[] = [{ type: "focusModule", module: "database" }];
    if (!connectionId) return intents;

    // 结果感知：从工具结果提取新创建的资源
    if (parsedResult) {
      // 创建库 → selectDatabase
      if (toolName.includes("create_database") || toolName.includes("create_db")) {
        const dbName = str(parsedResult.database) ?? str(parsedResult.database_name) ?? str(args.database_name);
        if (dbName) {
          intents.push({ type: "selectDatabase", connectionId, database: dbName });
          return intents;
        }
      }
      // 创建表 → selectTable
      if (toolName.includes("create_table")) {
        const dbName = str(parsedResult.database) ?? str(args.database);
        const tableName = str(parsedResult.table) ?? str(parsedResult.table_name);
        if (dbName && tableName) {
          intents.push({ type: "selectTable", connectionId, database: dbName, table: tableName });
          return intents;
        }
      }
    }

    // 参数感知：执行 SQL → openSqlDraft
    if (toolName.includes("execute_sql") || toolName.includes("run_sql")) {
      intents.push({
        type: "openSqlDraft",
        connectionId,
        database: str(args.database) ?? str(args.database_name),
        sql,
      });
      return intents;
    }

    // 默认：切到数据库 + 选中连接
    intents.push({
      type: "openSqlDraft",
      connectionId,
      database: str(args.database) ?? str(args.database_name),
      sql: null,
    });
    return intents;
  }

  // === SSH 工具 ===
  if (toolName.startsWith("omni_ssh_")) {
    const intents: UiFollowIntent[] = [{ type: "focusModule", module: "ssh" }];
    if (!connectionId) return intents;

    // 结果感知：exec 命令中提取文件路径 → revealSftpPath
    if (toolName === "omni_ssh_exec") {
      const command = str(args.command);
      if (command) {
        const filePath = extractFilePathFromCommand(command);
        if (filePath) {
          intents.push({ type: "revealSftpPath", resourceId: connectionId, path: filePath });
          return intents;
        }
      }
    }

    // 默认：切到 SSH + 选中连接
    intents.push({ type: "openConnection", module: "ssh", resourceId: connectionId });
    return intents;
  }

  // === 文件工具 ===
  if (toolName.startsWith("omni_files_")) {
    const intents: UiFollowIntent[] = [{ type: "focusModule", module: "files" }];
    if (connectionId && path && (toolName.includes("write") || toolName.includes("read"))) {
      intents.push({ type: "openFile", connectionId, path });
    } else if (connectionId) {
      intents.push({ type: "openConnection", module: "files", resourceId: connectionId });
    }
    return intents;
  }

  // === 终端工具 ===
  if (toolName === "omni_terminal_run_terminal_command" && sessionId) {
    return [{ type: "revealTerminal", sessionId }];
  }

  // === 工作区工具 ===
  if (toolName.startsWith("omni_workspace_")) {
    const workspaceId = str(args.workspace_id) ?? str(args.id);
    if (toolName.includes("switch") && workspaceId) {
      return [{ type: "switchWorkspace", workspaceId }];
    }
  }

  return [];
}

/**
 * 应用工具 Follow。
 *
 * @param toolName 工具名
 * @param argsJson 工具参数 JSON 字符串
 * @param result 工具执行结果（可选，用于结果感知推断）
 */
export function applyUiFollowForTool(
  toolName: string,
  argsJson: string,
  result?: string | null,
): void {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
  } catch {
    // ignore
  }
  const intents = followIntentsForTool(toolName, args, result);
  if (intents.length === 1) {
    followAiIntent(intents[0]!);
  } else if (intents.length > 1) {
    followAiIntents(intents);
  }
}
