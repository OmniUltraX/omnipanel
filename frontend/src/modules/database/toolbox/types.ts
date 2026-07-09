import type { DbColumnMeta, DbConnectionConfig, DbIndexMeta } from "../api";
import type { SchemaTableDiff } from "./schemaDiff";

export type ToolboxTabId = "dataSync" | "schemaSync";

/** 结构同步新建表时的表名大小写规则 */
export type SchemaTableNameCase = "upper" | "lower";

export const DEFAULT_SCHEMA_TABLE_NAME_CASE: SchemaTableNameCase = "lower";

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

/**
 * 结合行级比对结果解析目标侧状态。
 * 行级分析完成后不再回退为「检测中」，避免与「行一致 / 差异 x 行」同时展示。
 */
export function resolveTableTargetStatusWithAnalysis(
  tableName: string,
  targetTableNames: Set<string>,
  sourceRowCount: number | null | undefined,
  targetRowCount: number | null | undefined,
  analysis?: DataAnalysisResult,
): TableTargetStatus | undefined {
  if (analysis?.status === "diff") {
    return "conflict";
  }
  if (analysis?.status === "match" || analysis?.status === "error") {
    return undefined;
  }
  if (analysis?.status === "analyzing") {
    return undefined;
  }
  return resolveDataSyncConflictStatus(
    tableName,
    targetTableNames,
    sourceRowCount,
    targetRowCount,
  );
}

/** 是否应保留冲突表同步策略（行级差异或行数冲突） */
export function shouldKeepDataSyncStrategy(
  tableName: string,
  targetTableNames: Set<string>,
  sourceRowCount: number | null | undefined,
  targetRowCount: number | null | undefined,
  analysis?: DataAnalysisResult,
): boolean {
  return (
    resolveTableTargetStatusWithAnalysis(
      tableName,
      targetTableNames,
      sourceRowCount,
      targetRowCount,
      analysis,
    ) === "conflict"
  );
}

/** 数据同步方式（可多选组合） */
export interface DataSyncModes {
  /** 新增：源有、目标无 → INSERT */
  insert: boolean;
  /** 合并：双方均有且字段冲突 → UPDATE（以源为准） */
  merge: boolean;
  /** 删除：目标有、源无 → DELETE */
  delete: boolean;
}

export const DEFAULT_DATA_SYNC_MODES: DataSyncModes = {
  insert: true,
  merge: true,
  delete: false,
};

export const EMPTY_DATA_SYNC_MODES: DataSyncModes = {
  insert: false,
  merge: false,
  delete: false,
};

export function hasAnyDataSyncMode(modes: DataSyncModes): boolean {
  return modes.insert || modes.merge || modes.delete;
}

export function normalizeDataSyncModes(
  value: Partial<DataSyncModes> | undefined | null,
  fallback: DataSyncModes = DEFAULT_DATA_SYNC_MODES,
): DataSyncModes {
  if (!value || typeof value !== "object") {
    return { ...fallback };
  }
  return {
    insert: Boolean(value.insert),
    merge: Boolean(value.merge),
    delete: Boolean(value.delete),
  };
}

/** @deprecated 旧版单选策略，读取任务配置时迁移为 DataSyncModes */
export type DataSyncStrategy =
  | "source"
  | "mergeSource"
  | "mergeTarget"
  | "conflictSource"
  | "conflictTarget"
  | "target";

export function migrateLegacyDataSyncStrategy(
  strategy: string | undefined | null,
): DataSyncModes {
  const normalized = normalizeDataSyncStrategy(strategy, "mergeSource");
  switch (normalized) {
    case "target":
    case "mergeTarget":
    case "conflictTarget":
      return { ...EMPTY_DATA_SYNC_MODES };
    case "conflictSource":
      return { insert: false, merge: true, delete: false };
    case "source":
      return { insert: true, merge: true, delete: true };
    case "mergeSource":
    default:
      return { insert: true, merge: true, delete: false };
  }
}

export function normalizeDataSyncStrategy(
  value: string | undefined | null,
  fallback: DataSyncStrategy = "source",
): DataSyncStrategy {
  if (value === "target") {
    return "target";
  }
  if (value === "mergeTarget" || value === "merge_target") {
    return "mergeTarget";
  }
  if (value === "conflictTarget" || value === "conflict_target") {
    return "conflictTarget";
  }
  if (value === "mergeSource" || value === "merge_source" || value === "merge" || value === "append") {
    return "mergeSource";
  }
  if (value === "conflictSource" || value === "conflict_source") {
    return "conflictSource";
  }
  if (value === "source" || value === "rewrite" || value === "update") {
    return "source";
  }
  return fallback;
}

export function normalizeTableSyncModes(
  modes: Record<string, Partial<DataSyncModes>> | undefined,
  legacyStrategies?: Record<string, string>,
): Record<string, DataSyncModes> {
  const next: Record<string, DataSyncModes> = {};
  if (modes) {
    for (const [name, value] of Object.entries(modes)) {
      next[name] = normalizeDataSyncModes(value);
    }
  }
  if (legacyStrategies) {
    for (const [name, strategy] of Object.entries(legacyStrategies)) {
      if (!next[name]) {
        next[name] = migrateLegacyDataSyncStrategy(strategy);
      }
    }
  }
  return next;
}

/** @deprecated 使用 normalizeTableSyncModes */
export function normalizeTableSyncStrategies(
  strategies: Record<string, string> | undefined,
): Record<string, DataSyncStrategy> {
  if (!strategies) {
    return {};
  }
  const next: Record<string, DataSyncStrategy> = {};
  for (const [name, strategy] of Object.entries(strategies)) {
    next[name] = normalizeDataSyncStrategy(strategy);
  }
  return next;
}

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
  /** 本地差异缓存 ID（分析完成后写入 app_data，详情面板分页读取） */
  diffCacheId?: string;
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
  indexes: DbIndexMeta[];
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

/** 结构同步目标侧单行状态 */
export type SchemaTargetRowStatus = "new" | "diff" | "targetOnly" | "match";

/** 持久化迁移：旧版单选状态筛选，读取时 normalize 为数组 */
type PersistedSchemaTargetStatusFilter = "all" | SchemaTargetRowStatus;

export const ALL_SCHEMA_TARGET_ROW_STATUSES: SchemaTargetRowStatus[] = [
  "new",
  "diff",
  "targetOnly",
  "match",
];

/** 将持久化配置 normalize 为多选数组；空数组表示全部状态 */
export function normalizeSchemaTargetStatusFilters(
  raw?: PersistedSchemaTargetStatusFilter | SchemaTargetRowStatus[] | null,
): SchemaTargetRowStatus[] {
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.filter((item): item is SchemaTargetRowStatus =>
      ALL_SCHEMA_TARGET_ROW_STATUSES.includes(item as SchemaTargetRowStatus),
    );
  }
  if (raw === "all") {
    return [];
  }
  return ALL_SCHEMA_TARGET_ROW_STATUSES.includes(raw) ? [raw] : [];
}

/** 是否处于「显示全部状态」 */
export function isSchemaTargetStatusFilterShowAll(filters: SchemaTargetRowStatus[]): boolean {
  return (
    filters.length === 0 || filters.length >= ALL_SCHEMA_TARGET_ROW_STATUSES.length
  );
}

/** 从任务配置解析结构同步状态筛选（含 showMatchingTables 旧字段迁移） */
export function resolveSchemaTargetStatusFiltersFromConfig(
  config: Pick<SyncTaskConfig, "schemaTargetStatusFilter"> & {
    showMatchingTables?: boolean;
  },
): SchemaTargetRowStatus[] {
  if (config.schemaTargetStatusFilter != null) {
    return normalizeSchemaTargetStatusFilters(config.schemaTargetStatusFilter);
  }
  if (config.showMatchingTables === false) {
    return ALL_SCHEMA_TARGET_ROW_STATUSES.filter((status) => status !== "match");
  }
  return [];
}

/** 同步任务分析结果缓存（随任务配置持久化） */
export interface SyncTaskAnalysisCache {
  /** 分析完成时间戳 */
  analyzedAt: number;
  /** 分析时的连接/库/选项指纹，用于判断缓存是否仍有效 */
  configKey: string;
  schemaDiffs?: Record<string, SchemaTableDiff>;
  tableAnalysis?: Record<string, DataAnalysisResult>;
  targetRowCounts?: Record<string, number | null>;
}

/** 可持久化的同步任务配置快照 */
export interface SyncTaskConfig {
  sourceConnId: string;
  sourceDb: string;
  targetConnId: string;
  targetDb: string;
  selectedTables: string[];
  /** 源侧已添加到列表的表（未持久化时回退为 selectedTables） */
  addedTables?: string[];
  expandedTables?: string[];
  tableSyncModes?: Record<string, DataSyncModes>;
  /** @deprecated 旧版单选策略，加载时迁移为 tableSyncModes */
  tableSyncStrategies?: Record<string, DataSyncStrategy>;
  /** 结构同步：比较表名时是否区分大小写，默认 true */
  schemaCaseSensitive?: boolean;
  /** 结构同步：新建表时的表名大小写（大写 / 小写） */
  schemaTableNameCase?: SchemaTableNameCase;
  /** 结构同步：目标库不存在时是否新建表，默认 true */
  schemaCreateMissingTables?: boolean;
  /** 结构同步：目标侧表状态筛选（空数组表示全部） */
  schemaTargetStatusFilter?: SchemaTargetRowStatus[] | PersistedSchemaTargetStatusFilter;
  /** 结构同步：表名搜索过滤 */
  schemaTableSearch?: string;
  /** 上次分析结果缓存 */
  analysisCache?: SyncTaskAnalysisCache;
  /** 数据同步：对比分析时忽略的字段（表.字段，每行一条） */
  ignoredFields?: string[];
}

export interface SyncTask {
  id: string;
  name: string;
  kind: ToolboxTabId;
  config: SyncTaskConfig;
  createdAt: number;
  updatedAt: number;
}

/** 同步任务单次执行记录（提交后台同步后持久化） */
export type SyncTaskRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface SyncTaskRunRecord {
  id: string;
  bgTaskId: string;
  kind: ToolboxTabId;
  status: SyncTaskRunStatus;
  tableCount: number;
  tableNames: string[];
  startedAt: number;
  finishedAt?: number | null;
  progress?: string;
  error?: string | null;
}

/** 同步任务单次分析记录（分析完成后持久化） */
export type SyncTaskAnalysisStatus = "completed" | "partial" | "failed";

export interface SyncTaskAnalysisRecord {
  id: string;
  kind: ToolboxTabId;
  status: SyncTaskAnalysisStatus;
  tableCount: number;
  tableNames: string[];
  startedAt: number;
  finishedAt: number;
  /** 差异/一致等摘要 */
  summary?: string;
  configKey?: string;
}
