import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { DbColumnMeta, DbConnectionConfig, DbIndexMeta } from "../api";
import type { DataAnalysisResult } from "./types";
import type { SchemaTableDiff } from "./schemaDiff";
import { sourceTableSchemaSignature } from "./schemaDiff";
import {
  cancelBackgroundTask,
  submitDbDataSyncAnalysis,
  submitDbDataSyncExecute,
  submitDbSchemaSyncAnalysis,
  submitDbSchemaSyncExecute,
} from "../../../stores/backgroundTaskStore";

export interface BgTaskDbEventPayload {
  taskId: string;
  eventType: string;
  table?: string | null;
  count?: {
    table: string;
    side: string;
    count?: number | null;
  } | null;
  rowResult?: {
    table: string;
    status: string;
    diffRows?: number | null;
    diffs?: Array<{
      rowKey: string;
      displayKey: string;
      kind: string;
      changedFields?: string[] | null;
      sourceRow?: Record<string, unknown> | null;
      targetRow?: Record<string, unknown> | null;
    }>;
    truncated?: boolean | null;
    error?: string | null;
  } | null;
  schemaResult?: {
    table: string;
    status: string;
    columns: Array<{
      name: string;
      kind: string;
      sourceType?: string | null;
      targetType?: string | null;
    }>;
    indexes?: Array<{
      name: string;
      kind: string;
      sourceDetail?: string | null;
      targetDetail?: string | null;
    }>;
    error?: string | null;
  } | null;
}

interface DbSyncBackgroundTaskHandlers {
  active: boolean;
  sourceTableColumns: Record<string, DbColumnMeta[]>;
  sourceTableIndexes: Record<string, DbIndexMeta[]>;
  targetKey: string;
  onTargetRowCount: (table: string, count: number | null) => void;
  onTableAnalysis: (table: string, result: DataAnalysisResult) => void;
  onSchemaDiff: (table: string, diff: SchemaTableDiff) => void;
  onAnalysisTablesPending: (tables: string[], pending: boolean) => void;
  onTargetCounting: (tables: string[], counting: boolean) => void;
}

export function useDbSyncBackgroundTaskEvents({
  active,
  sourceTableColumns,
  sourceTableIndexes,
  targetKey,
  onTargetRowCount,
  onTableAnalysis,
  onSchemaDiff,
  onAnalysisTablesPending,
  onTargetCounting,
}: DbSyncBackgroundTaskHandlers) {
  useEffect(() => {
    if (!active) return;

    const unsubs: Array<() => void> = [];
    listen<BgTaskDbEventPayload>("bg-task-db-event", (event) => {
      const payload = event.payload;
      const table =
        payload.table ??
        payload.count?.table ??
        payload.rowResult?.table ??
        payload.schemaResult?.table;
      if (!table) return;

      if (payload.eventType === "count" && payload.count) {
        onTargetCounting([table], false);
        onTargetRowCount(table, payload.count.count ?? -1);
        return;
      }

      if (payload.eventType === "row_result" && payload.rowResult) {
        onAnalysisTablesPending([table], false);
        const row = payload.rowResult;
        if (row.status === "error") {
          onTableAnalysis(table, { status: "error", error: row.error ?? "unknown error" });
          return;
        }
        if (row.status === "match") {
          onTableAnalysis(table, { status: "match", diffRows: 0, diffs: [] });
          return;
        }
        onTableAnalysis(table, {
          status: "diff",
          diffRows: row.diffRows ?? 0,
          diffs: (row.diffs ?? []).map((d) => ({
            rowKey: d.rowKey,
            displayKey: d.displayKey,
            kind: d.kind as "changed" | "sourceOnly" | "targetOnly",
            changedFields: d.changedFields ?? undefined,
            sourceRow: d.sourceRow ?? undefined,
            targetRow: d.targetRow ?? undefined,
          })),
          truncated: row.truncated ?? undefined,
        });
        return;
      }

      if (payload.eventType === "schema_result" && payload.schemaResult) {
        const schema = payload.schemaResult;
        if (schema.status === "error") {
          onSchemaDiff(table, {
            tableName: table,
            status: "error",
            columns: [],
            indexes: [],
            error: schema.error ?? "unknown error",
          });
          return;
        }
        const sourceKey = sourceTableSchemaSignature(
          sourceTableColumns[table] ?? [],
          sourceTableIndexes[table] ?? [],
        );
        onSchemaDiff(table, {
          tableName: table,
          status: schema.status === "match" ? "match" : "diff",
          columns: schema.columns.map((c) => ({
            name: c.name,
            kind: c.kind as "added" | "removed" | "changed",
            sourceType: c.sourceType ?? undefined,
            targetType: c.targetType ?? undefined,
          })),
          indexes: (schema.indexes ?? []).map((idx) => ({
            name: idx.name,
            kind: idx.kind as "added" | "removed" | "changed",
            sourceDetail: idx.sourceDetail ?? undefined,
            targetDetail: idx.targetDetail ?? undefined,
          })),
          targetKey,
          sourceKey,
        });
      }
    })
      .then((fn) => unsubs.push(fn))
      .catch(() => {});

    return () => {
      for (const fn of unsubs) fn();
    };
  }, [
    active,
    onAnalysisTablesPending,
    onSchemaDiff,
    onTableAnalysis,
    onTargetCounting,
    onTargetRowCount,
    sourceTableColumns,
    sourceTableIndexes,
    targetKey,
  ]);
}

export async function cancelDbBackgroundTask(taskId: string | null) {
  if (!taskId) return;
  try {
    await cancelBackgroundTask(taskId);
  } catch {
    // ignore
  }
}

export async function startDbDataSyncBackgroundTask(
  sourceConn: DbConnectionConfig,
  targetConn: DbConnectionConfig,
  sourceDb: string,
  targetDb: string,
  tables: string[],
  sourceTableColumns: Record<string, DbColumnMeta[]>,
): Promise<string> {
  const specs = tables.map((name) => ({
    name,
    columns: sourceTableColumns[name] ?? [],
  }));
  return submitDbDataSyncAnalysis(
    { ...sourceConn, database: sourceDb },
    { ...targetConn, database: targetDb },
    specs,
  );
}

export async function startDbSchemaSyncBackgroundTask(
  targetConn: DbConnectionConfig,
  targetDb: string,
  tables: string[],
  sourceTableColumns: Record<string, DbColumnMeta[]>,
  sourceTableIndexes: Record<string, DbIndexMeta[]>,
): Promise<string> {
  const specs = tables.map((name) => ({
    name,
    columns: sourceTableColumns[name] ?? [],
    indexes: sourceTableIndexes[name] ?? [],
  }));
  return submitDbSchemaSyncAnalysis({ ...targetConn, database: targetDb }, targetDb, specs);
}

export async function startDbDataSyncExecute(
  sourceConn: DbConnectionConfig,
  targetConn: DbConnectionConfig,
  sourceDb: string,
  targetDb: string,
  tables: Array<{
    name: string;
    columns: DbColumnMeta[];
    strategy?: string;
  }>,
): Promise<string> {
  const specs = tables.map((table) => ({
    name: table.name,
    columns: table.columns,
    strategy: table.strategy ?? null,
  }));
  return submitDbDataSyncExecute(
    { ...sourceConn, database: sourceDb },
    { ...targetConn, database: targetDb },
    specs,
  );
}

export async function startDbSchemaSyncExecute(
  sourceConn: DbConnectionConfig,
  targetConn: DbConnectionConfig,
  sourceDb: string,
  targetDb: string,
  tables: string[],
  sourceTableColumns: Record<string, DbColumnMeta[]>,
  sourceTableIndexes: Record<string, DbIndexMeta[]>,
): Promise<string> {
  const specs = tables.map((name) => ({
    name,
    columns: sourceTableColumns[name] ?? [],
    indexes: sourceTableIndexes[name] ?? [],
  }));
  return submitDbSchemaSyncExecute(
    { ...sourceConn, database: sourceDb },
    { ...targetConn, database: targetDb },
    specs,
  );
}
