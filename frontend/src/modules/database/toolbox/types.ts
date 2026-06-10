import type { DbColumnMeta, DbConnectionConfig } from "../api";

export type ToolboxTabId = "dataSync" | "schemaSync";

/** 源表在目标库中的存在状态（仅数据同步、已勾选时展示） */
export type TableTargetStatus = "checking" | "new" | "conflict";

/**
 * 数据同步冲突判定：目标无表 → 新增；行数均为 0 → 不冲突；
 * 行数不一致 → 冲突；行数一致且均 > 0 → 不冲突。
 */
export function resolveDataSyncConflictStatus(
  tableName: string,
  targetTableNames: Set<string>,
  sourceRowCount: number | null | undefined,
  targetRowCount: number | null | undefined,
): TableTargetStatus | undefined {
  if (!targetTableNames.has(tableName)) {
    return "new";
  }
  if (sourceRowCount == null || targetRowCount == null) {
    return "checking";
  }
  if (sourceRowCount < 0 || targetRowCount < 0) {
    return "checking";
  }
  if (sourceRowCount === 0 && targetRowCount === 0) {
    return undefined;
  }
  if (sourceRowCount !== targetRowCount) {
    return "conflict";
  }
  return undefined;
}

/** 冲突表的数据同步策略 */
export type DataSyncStrategy = "rewrite" | "append" | "update";

/** 逐条比对（行级 diff）状态：未执行 / 执行中 / 全部一致 / 存在差异 / 失败 */
export type DataAnalysisStatus = "unchecked" | "analyzing" | "match" | "diff" | "error";

export interface DataAnalysisResult {
  status: DataAnalysisStatus;
  /** 不一致的行数（status === "diff" 时有值） */
  diffRows?: number;
  /** 错误信息（status === "error" 时） */
  error?: string;
}

export type SyncSideId = "source" | "target";

export interface SyncSideSelection {
  connectionId: string;
  database: string;
}

export interface SyncTableInfo {
  name: string;
  columns: DbColumnMeta[];
  rowCount: number | null;
}

export interface SyncSideSnapshot {
  tables: SyncTableInfo[];
  loading: boolean;
  error: string | null;
}

export function connectionWithDatabase(
  conn: DbConnectionConfig,
  database: string,
): DbConnectionConfig {
  return { ...conn, database: database.trim() };
}
