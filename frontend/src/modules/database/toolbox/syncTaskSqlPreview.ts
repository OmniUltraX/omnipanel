import { commands } from "../../../ipc/bindings";
import { unwrapCommand } from "../../../ipc/result";
import type { DbColumnMeta, DbConnectionConfig, DbIndexMeta } from "../api";
import { resolveSchemaSyncTargetTableName } from "./schemaSyncAlignedTables";
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

function formatSyncModesLabel(modes: DataSyncModes): string {
  const parts: string[] = [];
  if (modes.insert) parts.push("新增");
  if (modes.merge) parts.push("合并");
  if (modes.delete) parts.push("删除");
  return parts.length > 0 ? parts.join(" / ") : "无";
}

function buildInsertPreviewSql(
  dbType: string,
  table: string,
  columns: DbColumnMeta[],
  rowCount: number | null,
): string {
  const colList = columns.map((c) => quoteIdent(dbType, c.name)).join(", ");
  const hint =
    typeof rowCount === "number" ? ` /* 源表约 ${rowCount.toLocaleString()} 行 */` : "";
  return `INSERT INTO ${quoteIdent(dbType, table)} (${colList}) VALUES (...)${hint}`;
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

function buildDataTablePreviewLines(
  input: SyncTaskSqlPreviewInput,
  tableName: string,
  ddlByTable: Record<string, string>,
): string[] {
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
    const ddl = ddlByTable[tableName];
    if (ddl && !ddl.startsWith("--")) {
      lines.push(`${normalizeCreateTableDdl(ddl, dbType)};`);
    } else {
      lines.push(ddl?.startsWith("--") ? ddl : `-- 无法获取建表语句: ${tableName}`);
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

async function fetchSchemaPreviewByTable(
  input: SyncTaskSqlPreviewInput,
): Promise<Record<string, string>> {
  const specs = input.tableNames.map((name) => {
    const targetName = resolveSchemaSyncTargetTableName(
      name,
      input.targetTables,
      input.schemaCaseSensitive,
      input.schemaTableNameCase,
    );
    return {
      name,
      ...(targetName !== name ? { targetName } : {}),
      columns: input.sourceTableColumns[name] ?? [],
      indexes: input.sourceTableIndexes[name] ?? [],
    };
  });
  const rows = await unwrapCommand(
    commands.dbSchemaSyncPreviewSql(
      input.sourceConn as Parameters<typeof commands.dbSchemaSyncPreviewSql>[0],
      { ...input.targetConn, database: input.targetDb } as Parameters<
        typeof commands.dbSchemaSyncPreviewSql
      >[1],
      input.sourceDb,
      input.targetDb,
      specs as Parameters<typeof commands.dbSchemaSyncPreviewSql>[4],
      input.schemaCreateMissingTables,
    ),
  );
  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.table] = row.sql;
  }
  return map;
}

async function fetchBatchTableDdl(
  conn: DbConnectionConfig,
  schema: string,
  tables: string[],
): Promise<Record<string, string>> {
  if (tables.length === 0) {
    return {};
  }
  const rows = await unwrapCommand(
    commands.dbBatchTableDdl(
      { ...conn, database: schema } as Parameters<typeof commands.dbBatchTableDdl>[0],
      schema,
      tables,
    ),
  );
  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.table] = row.sql;
  }
  return map;
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

  if (input.tab === "schemaSync") {
    try {
      const byTable = await fetchSchemaPreviewByTable(input);
      for (const name of input.tableNames) {
        sections.push(`-- ── ${name} ──`);
        const sql = byTable[name] ?? "-- 无预览";
        sections.push(sql);
        sections.push("");
        syncExecuteConfirmLog("buildPreview:table", {
          table: name,
          lineCount: sql.split("\n").length,
          previewHead: sql.split("\n").slice(0, 3).join(" | "),
        });
      }
    } catch (e) {
      sections.push(`-- 预览生成失败: ${String(e)}`);
    }
  } else {
    const newTables = input.tableNames.filter(
      (name) => input.tableTargetStatus[name] === "new",
    );
    let ddlByTable: Record<string, string> = {};
    try {
      ddlByTable = await fetchBatchTableDdl(input.sourceConn, input.sourceDb, newTables);
    } catch (e) {
      for (const name of newTables) {
        ddlByTable[name] = `-- 无法获取建表语句: ${String(e)}`;
      }
    }
    for (const name of input.tableNames) {
      sections.push(`-- ── ${name} ──`);
      const body = buildDataTablePreviewLines(input, name, ddlByTable);
      syncExecuteConfirmLog("buildPreview:table", {
        table: name,
        lineCount: body.length,
        previewHead: body.slice(0, 3).join(" | "),
      });
      sections.push(...body);
      sections.push("");
    }
  }

  const result = `${sections.join("\n").trimEnd()}\n`;
  syncExecuteConfirmLog("buildPreview:done", {
    textLength: result.length,
    lineCount: result.split("\n").length,
  });
  return result;
}
