import type { DataAnalysisResult } from "../toolbox/types";
import type { SchemaTableDiff } from "../toolbox/schemaDiff";
import { publishModuleStatusLog, clearModuleStatusLog } from "../../../lib/moduleStatusLog";

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

export interface DbDataSyncAnalysisProgressInput {
  countingTables: Set<string>;
  targetCountingTables: Set<string>;
  sourceSelected: Set<string>;
  sourceSelectedInTarget: string[];
  tableAnalysis: Record<string, DataAnalysisResult>;
}

export interface DbSchemaSyncAnalysisProgressInput {
  targetTablesLoading: boolean;
  sourceSelected: Set<string>;
  sourceSelectedInTarget: string[];
  schemaTableDiffs: Record<string, SchemaTableDiff>;
}

function firstSetItem(items: Set<string>): string {
  for (const item of items) {
    return item;
  }
  return "";
}

export function buildDbDataSyncAnalysisStatusMessage(
  t: TranslateFn,
  input: DbDataSyncAnalysisProgressInput,
): string | null {
  const analyzingTables = Object.entries(input.tableAnalysis)
    .filter(([, result]) => result.status === "analyzing")
    .map(([name]) => name);
  if (analyzingTables.length > 0) {
    const total = Math.max(input.sourceSelectedInTarget.length, 1);
    const done = input.sourceSelectedInTarget.filter((name) => {
      const status = input.tableAnalysis[name]?.status;
      return status === "match" || status === "diff" || status === "error";
    }).length;
    return t("database.toolbox.side.statusAnalysisRowCompare", {
      table: analyzingTables[0] ?? "",
      index: Math.min(done + 1, total),
      total,
    });
  }

  if (input.targetCountingTables.size > 0) {
    const total = Math.max(input.sourceSelectedInTarget.length, 1);
    const remaining = input.targetCountingTables.size;
    const index = Math.max(1, total - remaining + 1);
    return t("database.toolbox.side.statusAnalysisTargetCount", {
      table: firstSetItem(input.targetCountingTables),
      index: Math.min(index, total),
      total,
    });
  }

  if (input.countingTables.size > 0) {
    const total = Math.max(input.sourceSelected.size, 1);
    const remaining = input.countingTables.size;
    const index = Math.max(1, total - remaining + 1);
    return t("database.toolbox.side.statusAnalysisSourceCount", {
      table: firstSetItem(input.countingTables),
      index: Math.min(index, total),
      total,
    });
  }

  return null;
}

export function buildDbSchemaSyncAnalysisStatusMessage(
  t: TranslateFn,
  input: DbSchemaSyncAnalysisProgressInput,
): string | null {
  if (input.targetTablesLoading) {
    return t("database.toolbox.side.statusAnalysisSchemaLoadingTarget");
  }

  const checking = input.sourceSelectedInTarget.filter(
    (name) => input.schemaTableDiffs[name]?.status === "checking",
  );
  if (checking.length === 0) {
    return null;
  }

  const total = Math.max(input.sourceSelectedInTarget.length, 1);
  const done = input.sourceSelectedInTarget.filter((name) => {
    const status = input.schemaTableDiffs[name]?.status;
    return status === "match" || status === "diff" || status === "error";
  }).length;

  return t("database.toolbox.side.statusAnalysisSchemaCompare", {
    table: checking[0] ?? "",
    index: Math.min(done + 1, total),
    total,
  });
}

export function publishDbSyncAnalysisStatus(
  t: TranslateFn,
  tab: "dataSync" | "schemaSync",
  dataSyncBusy: boolean,
  schemaSyncBusy: boolean,
  dataSyncInput: DbDataSyncAnalysisProgressInput,
  schemaSyncInput: DbSchemaSyncAnalysisProgressInput,
): void {
  if (tab === "dataSync" && dataSyncBusy) {
    const message =
      buildDbDataSyncAnalysisStatusMessage(t, dataSyncInput) ??
      t("database.toolbox.side.syncProgressAnalyzing");
    publishModuleStatusLog("database", message, "progress");
    return;
  }

  if (tab === "schemaSync" && schemaSyncBusy) {
    const message =
      buildDbSchemaSyncAnalysisStatusMessage(t, schemaSyncInput) ??
      t("database.toolbox.side.statusAnalysisSchemaCompareGeneric");
    publishModuleStatusLog("database", message, "progress");
  }
}

export function finishDbSyncAnalysisStatus(t: TranslateFn): void {
  publishModuleStatusLog("database", t("database.toolbox.side.statusAnalysisDone"), "success");
}

export function clearDbSyncAnalysisStatus(): void {
  clearModuleStatusLog("database");
}
