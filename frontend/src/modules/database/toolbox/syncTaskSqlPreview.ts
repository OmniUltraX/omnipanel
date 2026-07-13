import { fetchTableDdl } from "../api";
import type { DbColumnMeta, DbConnectionConfig, DbIndexMeta } from "../api";
import {
  isSchemaSyncSourceTableMissingInTarget,
  resolveSchemaSyncTargetTableName,
} from "./schemaSyncAlignedTables";
import type { SchemaTableDiff } from "./schemaDiff";
import {
  type DataAnalysisResult,
  type DataSyncModes,
  type SchemaTableNameCase,
  type SyncTableInfo,
  type TableTargetStatus,
  type ToolboxTabId,
  DEFAULT_DATA_SYNC_MODES,
  hasAnyDataSyncMode,
  normalizeDataSyncModes,
} from "./types";
import {
  syncExecuteConfirmLog,
  syncExecuteConfirmWarn,
} from "./syncExecuteConfirmDebug";

export interface SyncTaskSqlPreviewInput {
  tab: ToolboxTabId;
  sourceConn: DbConnectionConfig;
  sourceDb: string;
  targetConn: DbConnectionConfig;
  targetDb: string;
  tableNames: string[];
  tableTargetStatus: Record<string, TableTargetStatus>;
  tableSyncModes: Record<string, DataSyncModes>;
  sourceTableColumns: Record<string, DbColumnMeta[]>;
  sourceTableIndexes: Record<string, DbIndexMeta[]>;
  schemaAnalysisDiffs: Record<string, SchemaTableDiff>;
  sourceRowCounts: Record<string, number | null>;
  targetTables: SyncTableInfo[];
  schemaCaseSensitive: boolean;
  schemaTableNameCase: SchemaTableNameCase;
  schemaCreateMissingTables: boolean;
  /** 数据同步行级分析结果（用于预览冲突行统计） */
  tableAnalysis?: Record<string, DataAnalysisResult>;
}

function isMysqlEngine(dbType: string): boolean {
  const t = dbType.toLowerCase();
  return t === "mysql" || t === "mariadb";
}

function isPostgresEngine(dbType: string): boolean {
  const t = dbType.toLowerCase();
  return t === "postgresql" || t === "postgres";
}

function quoteIdent(dbType: string, name: string): string {
  if (isMysqlEngine(dbType)) {
    return `\`${name.replace(/`/g, "``")}\``;
  }
  if (isPostgresEngine(dbType)) {
    return `"${name.replace(/"/g, '""')}"`;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

function normalizeCreateTableDdl(ddl: string, dbType: string): string {
  let sql = ddl.trim().replace(/;\s*$/, "");
  if (!sql.toUpperCase().includes("IF NOT EXISTS")) {
    sql = sql.replace(/^CREATE TABLE/i, "CREATE TABLE IF NOT EXISTS");
  }
  if (isMysqlEngine(dbType)) {
    const marker = "IF NOT EXISTS";
    const idx = sql.indexOf(marker);
    if (idx >= 0) {
      let tail = sql.slice(idx + marker.length).trimStart();
      const dot = tail.indexOf("`.`");
      if (tail.startsWith("`") && dot >= 0) {
        tail = tail.slice(dot + 3).trimStart();
        sql = `${sql.slice(0, idx + marker.length)} ${tail}`;
      }
    }
  }
  return sql;
}

function rewriteCreateTableDdlName(
  ddl: string,
  sourceTable: string,
  targetTable: string,
  dbType: string,
): string {
  if (sourceTable === targetTable) {
    return ddl;
  }
  const sourceQuoted = quoteIdent(dbType, sourceTable);
  const targetQuoted = quoteIdent(dbType, targetTable);
  if (ddl.includes(sourceQuoted)) {
    return ddl.replace(sourceQuoted, targetQuoted);
  }
  const sourcePattern = new RegExp(
    `(\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)(${escapeRegExp(sourceTable)})\\b`,
    "i",
  );
  if (sourcePattern.test(ddl)) {
    return ddl.replace(sourcePattern, `$1${targetTable}`);
  }
  return ddl;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatSyncModesLabel(modes: DataSyncModes): string {
  if (!hasAnyDataSyncMode(modes)) {
    return "未启用";
  }
  const parts: string[] = [];
  if (modes.insert) parts.push("新增");
  if (modes.merge) parts.push("合并");
  if (modes.delete) parts.push("删除");
  return parts.join(" + ");
}

function buildInsertPreviewSql(
  dbType: string,
  table: string,
  columns: DbColumnMeta[],
  rowCount: number | null,
): string {
  const tableIdent = quoteIdent(dbType, table);
  const colNames = columns.map((c) => quoteIdent(dbType, c.name)).join(", ");
  const rowsHint =
    rowCount != null && rowCount >= 0
      ? `-- 预计同步 ${rowCount.toLocaleString()} 行（分批 INSERT，每批约 150 行）`
      : "-- 预计从源库分批读取并 INSERT";
  const valuesHint = `-- INSERT INTO ${tableIdent} (${colNames}) VALUES (...), (...);`;
  return `${rowsHint}\n${valuesHint}`;
}

function buildAddColumnSql(dbType: string, table: string, col: DbColumnMeta): string {
  const tableIdent = quoteIdent(dbType, table);
  const colIdent = quoteIdent(dbType, col.name);
  const nullSql = col.nullable !== false ? "NULL" : "NOT NULL";
  return `ALTER TABLE ${tableIdent} ADD COLUMN ${colIdent} ${col.type} ${nullSql}`;
}

function buildModifyColumnSql(dbType: string, table: string, col: DbColumnMeta): string {
  const tableIdent = quoteIdent(dbType, table);
  const colIdent = quoteIdent(dbType, col.name);
  const nullSql = col.nullable !== false ? "NULL" : "NOT NULL";
  if (isMysqlEngine(dbType)) {
    return `ALTER TABLE ${tableIdent} MODIFY COLUMN ${colIdent} ${col.type} ${nullSql}`;
  }
  if (isPostgresEngine(dbType)) {
    return `ALTER TABLE ${tableIdent} ALTER COLUMN ${colIdent} TYPE ${col.type}`;
  }
  return "";
}

function buildCreateIndexSql(dbType: string, table: string, idx: DbIndexMeta): string {
  const tableIdent = quoteIdent(dbType, table);
  const idxIdent = quoteIdent(dbType, idx.name);
  const cols = idx.columns.map((c) => quoteIdent(dbType, c)).join(", ");
  const kind = idx.unique ? "CREATE UNIQUE INDEX" : "CREATE INDEX";
  return `${kind} ${idxIdent} ON ${tableIdent} (${cols})`;
}

function buildDropIndexSql(dbType: string, table: string, idx: DbIndexMeta): string {
  const tableIdent = quoteIdent(dbType, table);
  const idxIdent = quoteIdent(dbType, idx.name);
  if (isMysqlEngine(dbType)) {
    return `DROP INDEX ${idxIdent} ON ${tableIdent}`;
  }
  if (isPostgresEngine(dbType)) {
    return `DROP INDEX IF EXISTS ${idxIdent}`;
  }
  return "";
}

async function buildSchemaTablePreview(
  input: SyncTaskSqlPreviewInput,
  tableName: string,
): Promise<string[]> {
  const lines: string[] = [];
  const dbType = input.targetConn.db_type;
  const targetName = resolveSchemaSyncTargetTableName(
    tableName,
    input.targetTables,
    input.schemaCaseSensitive,
    input.schemaTableNameCase,
  );
  const diff = input.schemaAnalysisDiffs[tableName];
  const columns = input.sourceTableColumns[tableName] ?? [];
  const indexes = input.sourceTableIndexes[tableName] ?? [];
  const missingInTarget = isSchemaSyncSourceTableMissingInTarget(
    tableName,
    input.targetTables,
    input.schemaCaseSensitive,
  );

  if (missingInTarget) {
    if (!input.schemaCreateMissingTables) {
      lines.push(`-- 已关闭「新增表」，跳过: ${tableName}`);
      return lines;
    }
    try {
      const ddl = await fetchTableDdl(input.sourceConn, input.sourceDb, tableName);
      const normalized = normalizeCreateTableDdl(ddl, dbType);
      lines.push(
        `${rewriteCreateTableDdlName(normalized, tableName, targetName, dbType)};`,
      );
    } catch (e) {
      lines.push(`-- 无法获取建表语句: ${String(e)}`);
    }
    return lines;
  }

  if (diff?.status === "new") {
    try {
      const ddl = await fetchTableDdl(input.sourceConn, input.sourceDb, tableName);
      const normalized = normalizeCreateTableDdl(ddl, dbType);
      lines.push(
        `${rewriteCreateTableDdlName(normalized, tableName, targetName, dbType)};`,
      );
    } catch (e) {
      lines.push(`-- 无法获取建表语句: ${String(e)}`);
    }
    return lines;
  }

  if (!diff || diff.status === "match") {
    lines.push("-- 结构已一致，无需变更");
    return lines;
  }

  if (diff.status === "error") {
    lines.push(`-- 分析失败: ${diff.error ?? "unknown"}`);
    return lines;
  }

  for (const colDiff of diff.columns) {
    const col = columns.find((c) => c.name === colDiff.name);
    if (!col) {
      if (colDiff.kind === "removed") {
        lines.push(`-- 目标端多余列 ${colDiff.name}（执行时不会自动删除）`);
      }
      continue;
    }
    if (colDiff.kind === "added") {
      lines.push(`${buildAddColumnSql(dbType, targetName, col)};`);
    } else if (colDiff.kind === "changed") {
      const sql = buildModifyColumnSql(dbType, targetName, col);
      if (sql) {
        lines.push(`${sql};`);
      }
    }
  }

  for (const idxDiff of diff.indexes) {
    const idx = indexes.find((i) => i.name === idxDiff.name);
    if (!idx) {
      if (idxDiff.kind === "removed") {
        lines.push(`-- 目标端多余索引 ${idxDiff.name}（执行时不会自动删除）`);
      }
      continue;
    }
    if (idxDiff.kind === "added") {
      lines.push(`${buildCreateIndexSql(dbType, targetName, idx)};`);
    } else if (idxDiff.kind === "changed") {
      const dropSql = buildDropIndexSql(dbType, targetName, idx);
      if (dropSql) {
        lines.push(`${dropSql};`);
      }
      lines.push(`${buildCreateIndexSql(dbType, targetName, idx)};`);
    }
  }

  if (lines.length === 0) {
    lines.push("-- 无待执行结构变更");
  }

  return lines;
}

function appendDataAnalysisSummary(
  lines: string[],
  analysis: DataAnalysisResult | undefined,
): void {
  if (!analysis) {
    lines.push("-- 分析: 尚未完成行级对比");
    return;
  }
  if (analysis.status === "error") {
    lines.push(`-- 分析失败: ${analysis.error ?? "未知错误"}`);
    return;
  }
  if (analysis.status === "unchecked" || analysis.status === "analyzing") {
    lines.push("-- 分析: 行级对比进行中或未开始");
    return;
  }
  if (analysis.status === "match") {
    lines.push("-- 分析: 双方数据一致，无冲突行");
    return;
  }
  if (analysis.status === "diff") {
    const diffs = analysis.diffs ?? [];
    const sourceOnly = diffs.filter((d) => d.kind === "sourceOnly").length;
    const changed = diffs.filter((d) => d.kind === "changed").length;
    const targetOnly = diffs.filter((d) => d.kind === "targetOnly").length;
    const total = analysis.diffRows ?? diffs.length;
    if (diffs.length > 0 && !analysis.truncated && !analysis.diffCacheId) {
      lines.push(
        `-- 分析: 新增 ${sourceOnly} / 冲突 ${changed} / 目标多余 ${targetOnly} 行`,
      );
    } else {
      lines.push(`-- 分析: 差异合计 ${total} 行（含新增、冲突、目标多余）`);
    }
    if (analysis.truncated || analysis.diffCacheId) {
      lines.push("-- 分析明细已截断或分页缓存，可在「行差异」面板按类型筛选查看");
    }
  }
}

async function buildDataTablePreview(
  input: SyncTaskSqlPreviewInput,
  tableName: string,
): Promise<string[]> {
  const lines: string[] = [];
  const dbType = input.targetConn.db_type;
  const status = input.tableTargetStatus[tableName];
  const modes = normalizeDataSyncModes(
    input.tableSyncModes[tableName],
    status === "new" ? { insert: true, merge: false, delete: false } : DEFAULT_DATA_SYNC_MODES,
  );
  const columns = input.sourceTableColumns[tableName] ?? [];
  const rowCount = input.sourceRowCounts[tableName] ?? null;
  const pkCols = columns.filter((c) => c.isPk).map((c) => c.name);

  if (status === "new") {
    try {
      const ddl = await fetchTableDdl(input.sourceConn, input.sourceDb, tableName);
      lines.push(`${normalizeCreateTableDdl(ddl, dbType)};`);
    } catch (e) {
      lines.push(`-- 无法获取建表语句: ${String(e)}`);
    }
  }

  lines.push(`-- 同步方式: ${formatSyncModesLabel(modes)}`);
  if (status !== "new") {
    appendDataAnalysisSummary(lines, input.tableAnalysis?.[tableName]);
  }

  if (!hasAnyDataSyncMode(modes)) {
    lines.push("-- 未启用任何同步方式，预计不向目标库执行 DML");
    return lines;
  }

  if (modes.insert) {
    lines.push("-- 新增：将源表有、目标表无的行 INSERT 到目标表");
    const diffs = input.tableAnalysis?.[tableName]?.diffs ?? [];
    const sourceOnly = diffs.filter((d) => d.kind === "sourceOnly").length;
    if (sourceOnly > 0) {
      lines.push(`-- 预计新增约 ${sourceOnly} 行（来自行级分析）`);
    }
    lines.push(buildInsertPreviewSql(dbType, tableName, columns, rowCount));
  }

  if (modes.merge) {
    lines.push("-- 合并：双方均存在且字段冲突的行，以源表取值 UPDATE 目标表");
    lines.push(`-- UPDATE ${quoteIdent(dbType, tableName)} SET ... WHERE <主键>`);
    if (pkCols.length > 0) {
      lines.push(`-- 主键: ${pkCols.join(", ")}`);
    }
  }

  if (modes.delete) {
    lines.push("-- 删除：将目标表有、源表无的行从目标表 DELETE");
    lines.push(`-- DELETE FROM ${quoteIdent(dbType, tableName)} WHERE <主键>`);
    if (pkCols.length > 0) {
      lines.push(`-- 主键: ${pkCols.join(", ")}`);
    }
  }

  return lines;
}

/** 根据当前任务配置生成预计执行的 SQL 脚本（预览，不含真实行数据）。 */
export async function buildSyncTaskSqlPreview(input: SyncTaskSqlPreviewInput): Promise<string> {
  syncExecuteConfirmLog("buildPreview:start", {
    tab: input.tab,
    tableNames: input.tableNames,
    targetDbType: input.targetConn.db_type,
  });

  const header = [
    `-- ${input.tab === "dataSync" ? "数据同步" : "结构同步"} · 脚本预览`,
    `-- 源: ${input.sourceConn.name}/${input.sourceDb}`,
    `-- 目标: ${input.targetConn.name}/${input.targetDb}`,
    `-- 表数量: ${input.tableNames.length}`,
    "",
  ];

  if (input.tableNames.length === 0) {
    return [...header, "-- 未选择任何表"].join("\n");
  }

  const dbType = input.targetConn.db_type.toLowerCase();
  if (!isMysqlEngine(dbType) && !isPostgresEngine(dbType) && dbType !== "sqlite") {
    const unsupported = [...header, `-- 暂不支持 ${input.targetConn.db_type} 的脚本预览`].join("\n");
    syncExecuteConfirmWarn("buildPreview:unsupported-db", {
      dbType: input.targetConn.db_type,
      textLength: unsupported.length,
    });
    return unsupported;
  }

  const sections: string[] = [...header];

  for (const name of input.tableNames) {
    sections.push(`-- ── ${name} ──`);
    const body =
      input.tab === "schemaSync"
        ? await buildSchemaTablePreview(input, name)
        : await buildDataTablePreview(input, name);
    syncExecuteConfirmLog("buildPreview:table", {
      table: name,
      lineCount: body.length,
      previewHead: body.slice(0, 3).join(" | "),
    });
    sections.push(...body);
    sections.push("");
  }

  const result = `${sections.join("\n").trimEnd()}\n`;
  syncExecuteConfirmLog("buildPreview:done", {
    textLength: result.length,
    lineCount: result.split("\n").length,
  });
  return result;
}
