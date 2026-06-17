import type { DbColumnMeta } from "./api";

/** 从 Redis 预览列推断主键列，用于行定位与脏数据提交。 */
export function buildRedisColumnMeta(columns: string[]): DbColumnMeta[] {
  const pkName =
    columns.includes("field")
      ? "field"
      : columns.includes("index")
        ? "index"
        : columns.includes("member") && !columns.includes("score")
          ? "member"
          : columns.includes("key")
            ? "key"
            : (columns[0] ?? "key");

  return columns.map((name) => ({
    name,
    type: "varchar",
    isPk: name === pkName,
    isFk: false,
  }));
}

function readRowKeyValue(rowKey: string, colName: string): string {
  for (const part of rowKey.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) === colName) {
      return part.slice(eq + 1);
    }
  }
  return "";
}

function escapeRedisArg(value: string): string {
  if (/[\s"'\\]/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

/** 根据脏单元格变更生成 Redis 命令（供 db_execute_query 执行）。 */
export function buildRedisUpdateCommands(
  key: string,
  rowKey: string,
  pkCols: DbColumnMeta[],
  changes: Record<string, unknown>,
): string[] {
  const pkNames = new Set(pkCols.map((col) => col.name));
  const commands: string[] = [];

  if ("value" in changes && pkNames.has("field")) {
    const field = readRowKeyValue(rowKey, "field");
    commands.push(
      `HSET ${escapeRedisArg(key)} ${escapeRedisArg(field)} ${escapeRedisArg(String(changes.value ?? ""))}`,
    );
    return commands;
  }

  if ("value" in changes && pkNames.has("index")) {
    const index = readRowKeyValue(rowKey, "index");
    commands.push(
      `LSET ${escapeRedisArg(key)} ${index} ${escapeRedisArg(String(changes.value ?? ""))}`,
    );
    return commands;
  }

  if ("value" in changes && pkNames.has("key")) {
    commands.push(`SET ${escapeRedisArg(key)} ${escapeRedisArg(String(changes.value ?? ""))}`);
    return commands;
  }

  if ("score" in changes && pkNames.has("member")) {
    const member = readRowKeyValue(rowKey, "member");
    commands.push(
      `ZADD ${escapeRedisArg(key)} ${String(changes.score)} ${escapeRedisArg(member)}`,
    );
  }

  return commands;
}
