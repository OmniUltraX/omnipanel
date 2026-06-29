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

/** 单行差异详情 */
export interface TableRowDiff {
  rowKey: string;
  displayKey: string;
  kind: "changed" | "sourceOnly" | "targetOnly";
  changedFields?: string[];
  sourceRow?: Record<string, unknown>;
  targetRow?: Record<string, unknown>;
}

export interface DataAnalysisResult {
  status: DataAnalysisStatus;
  /** 不一致的行数（status === "diff" 时有值） */
  diffRows?: number;
  /** 行级差异明细（status === "diff" 时有值，可能被截断） */
  diffs?: TableRowDiff[];
  /** 差异行数超过展示上限时为 true */
  truncated?: boolean;
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

/** 可持久化的同步任务配置快照 */
export interface SyncTaskConfig {
  sourceConnId: string;
  sourceDb: string;
  targetConnId: string;
  targetDb: string;
  selectedTables: string[];
  expandedTables?: string[];
  tableSyncStrategies?: Record<string, DataSyncStrategy>;
}

export interface SyncTask {
  id: string;
  name: string;
  kind: ToolboxTabId;
  config: SyncTaskConfig;
  createdAt: number;
  updatedAt: number;
}
