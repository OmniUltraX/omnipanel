/** 表右键菜单的执行动作：复制、导出、克隆、危险 SQL。 */

import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { commands } from "../../../ipc/bindings";
import { unwrapCommand } from "../../../ipc/result";
import { appPrompt } from "../../../lib/appPrompt";
import { ACTION_DB_TRUNCATE, dropTableTarget } from "../../../lib/presenceTargets";
import { requireStepUp } from "../../../lib/stepUp";
import { agentIdForModule } from "../../../lib/ai/agents";
import { useAiStore } from "../../../stores/aiStore";
import { useDbSchemaCacheStore } from "../../../stores/dbSchemaCacheStore";
import { useDbSchemaFilterStore } from "../../../stores/dbSchemaFilterStore";
import { showToast } from "../../../stores/toastStore";
import { fetchTableDdl, isConnectionEnabled, type DbConnectionConfig } from "../api";
import { buildSelectAllFromTableSql } from "../grid/tablePreviewFilter";
import { buildInsertSql } from "../grid/tableDataGridCopySql";
import { writeToClipboard } from "../panel/useDatabasePanelCsvExport";
import { makeQueryRunId } from "../sql/queryRun";
import { buildTableExportCsv } from "../shared/tableExportCsv";
import { rowsToRecord } from "../workspace/dbWorkspaceState";
import { getCachedTableColumns, getCachedTableNames } from "./schemaCacheMerge";
import { buildDatabaseTreeItem } from "./schemaTreeItem";
import { refreshAndApplySchemaTreeNode } from "./schemaTreeRefresh";
import {
  isTablePinned,
  makeTableFilterKey,
  mergeFilter,
  toggleTablePin,
} from "./schemaFilterState";
import {
  allocateCloneTableName,
  buildCloneTableSql,
  isCloneTableSqlSupported,
} from "./tableCloneSql";
import {
  buildClearTableDataSql,
  buildCopyTableStatements,
  buildGeneratedTableSql,
  buildRenameTableSql,
  buildSetAutoIncrementSql,
  buildTruncateTableSql,
  isSafeTableIdentifier,
  type GeneratedTableSqlKind,
} from "./tableObjectSql";
import type { SchemaTableSelection } from "./schemaBrowserTypes";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const EXPORT_ROW_LIMIT = 20_000;

type SqlOpener = (connId: string, database: string, sql: string) => void;
type DatabaseExporter = (connection: DbConnectionConfig, databaseName: string) => void;

let sqlOpener: SqlOpener | null = null;
let databaseExporter: DatabaseExporter | null = null;

export function registerTableSqlOpener(opener: SqlOpener): () => void {
  sqlOpener = opener;
  return () => {
    if (sqlOpener === opener) sqlOpener = null;
  };
}

export function openTableSqlDraft(selection: SchemaTableSelection, sql: string): void {
  sqlOpener?.(selection.connId, selection.dbName, sql);
}

export function openSqlInNewQuery(connId: string, database: string, sql: string): void {
  sqlOpener?.(connId, database, sql);
}

export function registerTableDatabaseExport(exporter: DatabaseExporter): () => void {
  databaseExporter = exporter;
  return () => {
    if (databaseExporter === exporter) databaseExporter = null;
  };
}

export function exportSelectionDatabase(selection: SchemaTableSelection): void {
  databaseExporter?.(selection.connection, selection.dbName);
}

function boundConnection(selection: SchemaTableSelection): DbConnectionConfig {
  return { ...selection.connection, database: selection.dbName };
}

function fail(t: Translate, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  showToast(t("database.tableMenu.actionFailed", { error: message }));
}

function ensureEnabled(selection: SchemaTableSelection, t: Translate): boolean {
  if (isConnectionEnabled(selection.connection)) return true;
  showToast(t("database.tablesPanel.connectionDisabled"));
  return false;
}

async function runSql(
  selection: SchemaTableSelection,
  sql: string,
  token: string | null,
): Promise<void> {
  await unwrapCommand(
    commands.dbExecuteQuery(boundConnection(selection), sql, makeQueryRunId(), 1, 0, token),
  );
}

export function readTablePinned(selection: SchemaTableSelection): boolean {
  const key = makeTableFilterKey(selection.connId, selection.dbName);
  return isTablePinned(useDbSchemaFilterStore.getState().tableFilters[key], selection.tableName);
}

export function togglePinnedTable(selection: SchemaTableSelection): void {
  const key = makeTableFilterKey(selection.connId, selection.dbName);
  const names = getCachedTableNames(
    useDbSchemaCacheStore.getState().snapshot,
    selection.connId,
    selection.dbName,
  );
  const allNames = names.length > 0 ? names : [selection.tableName];
  useDbSchemaFilterStore.getState().setTableFilters((prev) => ({
    ...prev,
    [key]: toggleTablePin(prev[key], selection.tableName, allNames),
  }));
}

export async function copyTableName(name: string, t: Translate, count = 1): Promise<void> {
  const ok = await writeToClipboard(name);
  if (!ok) {
    showToast(t("database.tablesPanel.copyFailed"));
    return;
  }
  showToast(count > 1 ? t("database.tablesPanel.copiedNames", { count }) : t("common.copied"));
}

export function addTableToAi(selection: SchemaTableSelection, t: Translate): void {
  const store = useAiStore.getState();
  store.openDrawer();
  const convId =
    store.activeConversationId ??
    store.createConversation(undefined, undefined, { agentId: agentIdForModule("database") });
  store.addContext(convId, {
    type: "database",
    label: `${selection.connection.name} · ${selection.dbName}.${selection.tableName}`,
  });
  if (!store.draftPrompt.trim()) {
    store.setDraftPrompt(
      t("database.tableMenu.aiDraft", {
        database: selection.dbName,
        table: selection.tableName,
      }),
    );
  }
  showToast(t("database.tableMenu.addedToAi"));
}

export function openGeneratedTableSql(
  selection: SchemaTableSelection,
  kind: GeneratedTableSqlKind,
): void {
  const columns = getCachedTableColumns(
    useDbSchemaCacheStore.getState().snapshot,
    selection.connId,
    selection.dbName,
    selection.tableName,
  );
  const sql = buildGeneratedTableSql(
    selection.connection.db_type,
    selection.tableName,
    columns,
    kind,
  );
  if (!sql) return;
  openTableSqlDraft(selection, sql);
}

export async function refreshTableDatabase(selection: SchemaTableSelection): Promise<void> {
  await refreshAndApplySchemaTreeNode(
    boundConnection(selection),
    buildDatabaseTreeItem(selection.connId, selection.dbName),
    {
      syncTableFilter: (connId, dbName, names, options) => {
        const key = makeTableFilterKey(connId, dbName);
        useDbSchemaFilterStore.getState().setTableFilters((prev) => ({
          ...prev,
          [key]: mergeFilter(prev[key], names, options),
        }));
      },
    },
  );
}

async function copyOrFetchDdl(selection: SchemaTableSelection): Promise<string> {
  return fetchTableDdl(selection.connection, selection.dbName, selection.tableName);
}

export async function copyTableStructure(selection: SchemaTableSelection, t: Translate): Promise<void> {
  try {
    const ddl = await copyOrFetchDdl(selection);
    const ok = await writeToClipboard(ddl);
    showToast(ok ? t("database.contextMenu.copyDdlDone") : t("database.contextMenu.copyDdlFailed"));
  } catch {
    showToast(t("database.contextMenu.copyDdlFailed"));
  }
}

export async function viewTableDdlInSql(selection: SchemaTableSelection, t: Translate): Promise<void> {
  try {
    const ddl = await copyOrFetchDdl(selection);
    openTableSqlDraft(selection, ddl);
  } catch (error) {
    fail(t, error);
  }
}

export async function exportTableStructure(selection: SchemaTableSelection, t: Translate): Promise<void> {
  try {
    const ddl = await copyOrFetchDdl(selection);
    const path = await saveFileDialog({
      title: t("database.tableMenu.exportStructure"),
      defaultPath: `${selection.tableName}.sql`,
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });
    if (!path) return;
    await unwrapCommand(commands.writeTextFile(path, ddl));
    showToast(t("database.tableMenu.exportSaved"));
  } catch (error) {
    fail(t, error);
  }
}

async function loadExportRows(selection: SchemaTableSelection) {
  const sql = buildSelectAllFromTableSql(selection.connection.db_type, selection.tableName).replace(
    /;\s*$/u,
    "",
  );
  const result = await unwrapCommand(
    commands.dbExecuteQuery(
      boundConnection(selection),
      sql,
      makeQueryRunId(),
      EXPORT_ROW_LIMIT,
      0,
      null,
    ),
  );
  return {
    columns: result.columns,
    rows: rowsToRecord(result.columns, result.rows),
    truncated: result.rows.length >= EXPORT_ROW_LIMIT,
  };
}

export async function exportTableCsv(selection: SchemaTableSelection, t: Translate): Promise<void> {
  if (!ensureEnabled(selection, t)) return;
  try {
    const loaded = await loadExportRows(selection);
    if (loaded.columns.length === 0) {
      showToast(t("database.tableMenu.exportEmpty"));
      return;
    }
    const path = await saveFileDialog({
      title: t("database.tableMenu.exportCsv"),
      defaultPath: `${selection.tableName}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path) return;
    await unwrapCommand(
      commands.writeTextFile(path, buildTableExportCsv(loaded.columns, loaded.rows)),
    );
    showToast(
      loaded.truncated
        ? t("database.tableMenu.exportTruncated", { count: EXPORT_ROW_LIMIT })
        : t("database.tableMenu.exportSaved"),
    );
  } catch (error) {
    fail(t, error);
  }
}

export async function exportTableInsertSql(selection: SchemaTableSelection, t: Translate): Promise<void> {
  if (!ensureEnabled(selection, t)) return;
  try {
    const loaded = await loadExportRows(selection);
    if (loaded.rows.length === 0) {
      showToast(t("database.tableMenu.exportEmpty"));
      return;
    }
    const sql = buildInsertSql({
      dbType: selection.connection.db_type,
      tableName: selection.tableName,
      columns: loaded.columns,
      rows: loaded.rows,
      mode: "merged",
    });
    const path = await saveFileDialog({
      title: t("database.tableMenu.exportInsert"),
      defaultPath: `${selection.tableName}.insert.sql`,
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });
    if (!path) return;
    await unwrapCommand(commands.writeTextFile(path, sql.endsWith("\n") ? sql : `${sql}\n`));
    showToast(
      loaded.truncated
        ? t("database.tableMenu.exportTruncated", { count: EXPORT_ROW_LIMIT })
        : t("database.tableMenu.exportSaved"),
    );
  } catch (error) {
    fail(t, error);
  }
}

export async function cloneTables(
  selection: SchemaTableSelection,
  sourceNames: string[],
  existingNames: Iterable<string>,
  t: Translate,
  onDone?: () => void,
): Promise<void> {
  if (sourceNames.length === 0) return;
  if (!ensureEnabled(selection, t)) return;
  if (!isCloneTableSqlSupported(selection.connection.db_type)) {
    showToast(t("database.schemaTree.dropUnsupported"));
    return;
  }
  const existing = new Set(existingNames);
  let ok = 0;
  let failed = 0;
  for (const source of sourceNames) {
    const target = allocateCloneTableName(source, existing);
    const sql = buildCloneTableSql(selection.connection.db_type, selection.dbName, source, target);
    if (!sql) {
      failed += 1;
      continue;
    }
    try {
      await runSql(selection, sql, null);
      existing.add(target);
      ok += 1;
    } catch (error) {
      console.error("[tableMenu.clone] failed", source, error);
      failed += 1;
    }
  }
  if (ok > 0) {
    try {
      await refreshTableDatabase(selection);
      onDone?.();
    } catch (error) {
      console.error("[tableMenu.clone] refresh failed", error);
    }
  }
  if (ok > 0 && failed === 0) {
    showToast(t("database.tablesPanel.cloneDone", { count: ok }));
  } else if (ok > 0) {
    showToast(t("database.tablesPanel.clonePartial", { ok, failed }));
  } else {
    showToast(t("database.tablesPanel.cloneFailed"));
  }
}

export async function copyTablesWithData(
  selection: SchemaTableSelection,
  sourceNames: string[],
  existingNames: Iterable<string>,
  t: Translate,
  onDone?: () => void,
): Promise<void> {
  if (sourceNames.length === 0) return;
  if (!ensureEnabled(selection, t)) return;
  const existing = new Set(existingNames);
  let ok = 0;
  let failed = 0;
  for (const source of sourceNames) {
    const target = allocateCloneTableName(source, existing);
    const statements = buildCopyTableStatements(
      selection.connection.db_type,
      selection.dbName,
      source,
      target,
    );
    if (!statements) {
      failed += 1;
      continue;
    }
    try {
      await runSql(selection, statements.createSql, null);
      await runSql(selection, statements.insertSql, null);
      existing.add(target);
      ok += 1;
    } catch (error) {
      console.error("[tableMenu.copyData] failed", source, error);
      failed += 1;
    }
  }
  if (ok > 0) {
    try {
      await refreshTableDatabase(selection);
      onDone?.();
    } catch (error) {
      console.error("[tableMenu.copyData] refresh failed", error);
    }
  }
  if (ok > 0 && failed === 0) {
    showToast(t("database.tableMenu.copyTableDone", { count: ok }));
  } else if (ok > 0) {
    showToast(t("database.tableMenu.copyTablePartial", { ok, failed }));
  } else {
    showToast(t("database.tableMenu.copyTableFailed"));
  }
}

export async function renameTable(
  selection: SchemaTableSelection,
  t: Translate,
  onDone?: () => void,
): Promise<void> {
  if (!ensureEnabled(selection, t)) return;
  const next = await appPrompt(
    t("database.tableMenu.renameHint", { name: selection.tableName }),
    selection.tableName,
    t("database.tableMenu.rename"),
  );
  if (next == null) return;
  const name = next.trim();
  if (!isSafeTableIdentifier(name)) {
    showToast(t("database.tableMenu.invalidName"));
    return;
  }
  if (name === selection.tableName) return;
  const sql = buildRenameTableSql(
    selection.connection.db_type,
    selection.dbName,
    selection.tableName,
    name,
  );
  if (!sql) {
    showToast(t("database.schemaTree.dropUnsupported"));
    return;
  }
  try {
    await runSql(selection, sql, null);
    await refreshTableDatabase(selection);
    onDone?.();
    showToast(t("database.tableMenu.renameDone", { name }));
  } catch (error) {
    fail(t, error);
  }
}

export async function setTableAutoIncrement(
  selection: SchemaTableSelection,
  t: Translate,
  onDone?: () => void,
): Promise<void> {
  if (!ensureEnabled(selection, t)) return;
  const raw = await appPrompt(
    t("database.tableMenu.autoIncHint", { name: selection.tableName }),
    "1",
    t("database.tableMenu.setAutoIncrement"),
  );
  if (raw == null) return;
  const start = Number(raw.trim());
  const sql = buildSetAutoIncrementSql(
    selection.connection.db_type,
    selection.dbName,
    selection.tableName,
    start,
  );
  if (!sql) {
    showToast(t("database.tableMenu.invalidAutoInc"));
    return;
  }
  try {
    await runSql(selection, sql, null);
    onDone?.();
    showToast(t("database.tableMenu.autoIncDone", { value: start }));
  } catch (error) {
    fail(t, error);
  }
}

async function runDangerousTableSql(
  selection: SchemaTableSelection,
  kind: "truncate" | "clear",
  t: Translate,
  onDone?: () => void,
): Promise<void> {
  if (!ensureEnabled(selection, t)) return;
  const sql =
    kind === "truncate"
      ? buildTruncateTableSql(selection.connection.db_type, selection.dbName, selection.tableName)
      : buildClearTableDataSql(selection.connection.db_type, selection.dbName, selection.tableName);
  if (!sql) {
    showToast(t("database.schemaTree.dropUnsupported"));
    return;
  }
  const message = t(
    kind === "truncate" ? "database.tableMenu.confirmTruncate" : "database.tableMenu.confirmClear",
    { name: selection.tableName },
  );
  const token = await requireStepUp({
    action: ACTION_DB_TRUNCATE,
    target: dropTableTarget(selection.connection.id, selection.dbName, [selection.tableName]),
    title: t("database.schemaTree.confirmDeleteTitle"),
    message,
    reason: message,
    confirmLabel: t(kind === "truncate" ? "database.tableMenu.truncate" : "database.tableMenu.clearData"),
  });
  if (!token) return;
  try {
    await runSql(selection, sql, token);
    onDone?.();
    showToast(
      t(kind === "truncate" ? "database.tableMenu.truncateDone" : "database.tableMenu.clearDone", {
        name: selection.tableName,
      }),
    );
  } catch (error) {
    fail(t, error);
  }
}

export function truncateTable(
  selection: SchemaTableSelection,
  t: Translate,
  onDone?: () => void,
): Promise<void> {
  return runDangerousTableSql(selection, "truncate", t, onDone);
}

export function clearTableData(
  selection: SchemaTableSelection,
  t: Translate,
  onDone?: () => void,
): Promise<void> {
  return runDangerousTableSql(selection, "clear", t, onDone);
}
