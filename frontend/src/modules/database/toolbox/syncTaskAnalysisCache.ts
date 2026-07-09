import type { SchemaTableDiff } from "./schemaDiff";
import { normalizeIgnoredFieldEntry, parseIgnoredFieldsInput } from "./ignoredFields";
import type { DataAnalysisResult, SyncTaskAnalysisCache, ToolboxTabId } from "./types";

export function buildSyncAnalysisConfigKey(input: {
  tab: ToolboxTabId;
  sourceConnId: string;
  sourceDb: string;
  targetConnId: string;
  targetDb: string;
  schemaCaseSensitive?: boolean;
  schemaTableNameCase?: string;
  schemaCreateMissingTables?: boolean;
  ignoredFields?: string[];
}): string {
  const ignoredKey =
    input.tab === "dataSync"
      ? parseIgnoredFieldsInput(input.ignoredFields)
          .map((entry) => normalizeIgnoredFieldEntry(entry) ?? entry)
          .sort()
          .join(",")
      : "";
  return [
    input.tab,
    input.sourceConnId,
    input.sourceDb.trim(),
    input.targetConnId,
    input.targetDb.trim(),
    input.tab === "schemaSync" ? (input.schemaCaseSensitive !== false ? "1" : "0") : "",
    input.tab === "schemaSync" ? (input.schemaTableNameCase ?? "lower") : "",
    input.tab === "schemaSync" ? (input.schemaCreateMissingTables !== false ? "1" : "0") : "",
    ignoredKey,
  ].join("|");
}

export function isSyncAnalysisCacheValid(
  cache: SyncTaskAnalysisCache | undefined,
  configKey: string,
): cache is SyncTaskAnalysisCache {
  return Boolean(cache && cache.configKey === configKey);
}

export function buildSyncAnalysisCache(input: {
  configKey: string;
  analyzedAt: number;
  tab: ToolboxTabId;
  schemaDiffs?: Record<string, SchemaTableDiff>;
  tableAnalysis?: Record<string, DataAnalysisResult>;
  targetRowCounts?: Record<string, number | null>;
}): SyncTaskAnalysisCache {
  const cache: SyncTaskAnalysisCache = {
    configKey: input.configKey,
    analyzedAt: input.analyzedAt,
  };
  if (input.tab === "schemaSync" && input.schemaDiffs && Object.keys(input.schemaDiffs).length > 0) {
    cache.schemaDiffs = input.schemaDiffs;
  }
  if (input.tab === "dataSync") {
    if (input.tableAnalysis && Object.keys(input.tableAnalysis).length > 0) {
      cache.tableAnalysis = input.tableAnalysis;
    }
    if (input.targetRowCounts && Object.keys(input.targetRowCounts).length > 0) {
      cache.targetRowCounts = input.targetRowCounts;
    }
  }
  return cache;
}

export function pickPersistableTableAnalysis(
  tableAnalysis: Record<string, DataAnalysisResult>,
): Record<string, DataAnalysisResult> {
  const next: Record<string, DataAnalysisResult> = {};
  for (const [name, result] of Object.entries(tableAnalysis)) {
    if (result.status !== "analyzing") {
      next[name] = result;
    }
  }
  return next;
}

export function pickAnalysisCacheForRestore(
  cache: SyncTaskAnalysisCache | undefined,
  configKey: string,
): SyncTaskAnalysisCache | null {
  if (!isSyncAnalysisCacheValid(cache, configKey)) {
    return null;
  }
  return cache;
}
