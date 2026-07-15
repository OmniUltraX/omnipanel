import type { SyncSideSnapshot, SyncTableInfo, SchemaTargetRowStatus, SchemaTableNameCase } from "./types";
import { DEFAULT_SCHEMA_TABLE_NAME_CASE } from "./types";
import { isSchemaTargetStatusFilterShowAll } from "./types";
import type { SchemaTableDiff } from "./schemaDiff";
import { buildSchemaTableDiffFromSnapshots } from "./schemaDiff";

export function isSchemaCaseSensitive(caseSensitive?: boolean): boolean {
  return caseSensitive !== false;
}

export function tableNameKey(name: string, caseSensitive: boolean): string {
  return caseSensitive ? name : name.toLowerCase();
}

export function findTableByName(
  tables: SyncTableInfo[],
  name: string,
  caseSensitive: boolean,
): SyncTableInfo | undefined {
  if (caseSensitive) {
    return tables.find((table) => table.name === name);
  }
  const key = name.toLowerCase();
  return tables.find((table) => table.name.toLowerCase() === key);
}

export function tableNameExistsInSet(
  names: Set<string>,
  name: string,
  caseSensitive: boolean,
): boolean {
  if (caseSensitive) {
    return names.has(name);
  }
  const key = name.toLowerCase();
  for (const item of names) {
    if (item.toLowerCase() === key) {
      return true;
    }
  }
  return false;
}

export function resolveTargetTableName(
  sourceName: string,
  targetTables: SyncTableInfo[],
  caseSensitive: boolean,
): string | undefined {
  return findTableByName(targetTables, sourceName, caseSensitive)?.name;
}

export function applySchemaTableNameCase(
  name: string,
  nameCase: SchemaTableNameCase = DEFAULT_SCHEMA_TABLE_NAME_CASE,
): string {
  return nameCase === "upper" ? name.toUpperCase() : name.toLowerCase();
}

export function resolveSchemaTableNameCase(
  raw?: SchemaTableNameCase | null,
): SchemaTableNameCase {
  return raw === "upper" ? "upper" : DEFAULT_SCHEMA_TABLE_NAME_CASE;
}

/** 解析结构同步在目标库使用的表名（已存在则沿用目标侧名称，否则按大小写规则生成新表名）。 */
export function resolveSchemaSyncTargetTableName(
  sourceName: string,
  targetTables: SyncTableInfo[],
  caseSensitive: boolean,
  nameCase: SchemaTableNameCase = DEFAULT_SCHEMA_TABLE_NAME_CASE,
): string {
  const existing = resolveTargetTableName(sourceName, targetTables, caseSensitive);
  if (existing) {
    return existing;
  }
  return applySchemaTableNameCase(sourceName, nameCase);
}

export function isSchemaSyncSourceTableMissingInTarget(
  sourceName: string,
  targetTables: SyncTableInfo[],
  caseSensitive: boolean,
): boolean {
  return findTableByName(targetTables, sourceName, caseSensitive) === undefined;
}

/**
 * 结构同步可执行判断：结构一致不执行；新增/差异可执行；
 * 目标缺失表仅在允许建表时执行。
 */
export function isSchemaSyncTableExecutable(
  tableName: string,
  diffs: Record<string, Pick<SchemaTableDiff, "status">>,
  targetTables: SyncTableInfo[],
  caseSensitive: boolean,
  createMissingTables: boolean,
): boolean {
  const missing = isSchemaSyncSourceTableMissingInTarget(
    tableName,
    targetTables,
    caseSensitive,
  );
  if (missing) {
    return createMissingTables;
  }
  const status = diffs[tableName]?.status;
  return status === "diff" || status === "new";
}

export function filterSchemaSyncExecutableTableNames(
  tableNames: string[],
  diffs: Record<string, Pick<SchemaTableDiff, "status">>,
  targetTables: SyncTableInfo[],
  caseSensitive: boolean,
  createMissingTables: boolean,
): string[] {
  return tableNames.filter((name) =>
    isSchemaSyncTableExecutable(
      name,
      diffs,
      targetTables,
      caseSensitive,
      createMissingTables,
    ),
  );
}

function collectAlignedDisplayNames(
  sourceSnapshot: SyncSideSnapshot,
  targetSnapshot: SyncSideSnapshot,
  caseSensitive: boolean,
): string[] {
  if (caseSensitive) {
    const names = new Set<string>();
    for (const table of sourceSnapshot.tables) {
      names.add(table.name);
    }
    for (const table of targetSnapshot.tables) {
      names.add(table.name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  const displayByKey = new Map<string, string>();
  for (const table of sourceSnapshot.tables) {
    const key = table.name.toLowerCase();
    if (!displayByKey.has(key)) {
      displayByKey.set(key, table.name);
    }
  }
  for (const table of targetSnapshot.tables) {
    const key = table.name.toLowerCase();
    if (!displayByKey.has(key)) {
      displayByKey.set(key, table.name);
    }
  }
  return [...displayByKey.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => displayByKey.get(key)!);
}

export function buildSchemaAlignedTableNames(
  sourceSnapshot: SyncSideSnapshot,
  targetSnapshot: SyncSideSnapshot,
  caseSensitive = true,
): string[] {
  return collectAlignedDisplayNames(sourceSnapshot, targetSnapshot, caseSensitive);
}

export function buildSchemaDiffsFromSnapshots(
  sourceSnapshot: SyncSideSnapshot,
  targetSnapshot: SyncSideSnapshot,
  targetKey: string,
  caseSensitive = true,
): Record<string, SchemaTableDiff> {
  if (caseSensitive) {
    const sourceByName = new Map(sourceSnapshot.tables.map((table) => [table.name, table]));
    const targetByName = new Map(targetSnapshot.tables.map((table) => [table.name, table]));
    const names = new Set([...sourceByName.keys(), ...targetByName.keys()]);
    const result: Record<string, SchemaTableDiff> = {};
    for (const name of names) {
      result[name] = buildSchemaTableDiffFromSnapshots(
        name,
        sourceByName.get(name),
        targetByName.get(name),
        targetKey,
      );
    }
    return result;
  }

  const sourceByKey = new Map<string, SyncTableInfo>();
  for (const table of sourceSnapshot.tables) {
    const key = table.name.toLowerCase();
    if (!sourceByKey.has(key)) {
      sourceByKey.set(key, table);
    }
  }
  const targetByKey = new Map<string, SyncTableInfo>();
  for (const table of targetSnapshot.tables) {
    const key = table.name.toLowerCase();
    if (!targetByKey.has(key)) {
      targetByKey.set(key, table);
    }
  }

  const keys = new Set([...sourceByKey.keys(), ...targetByKey.keys()]);
  const result: Record<string, SchemaTableDiff> = {};
  for (const key of keys) {
    const source = sourceByKey.get(key);
    const target = targetByKey.get(key);
    const displayName = source?.name ?? target?.name ?? key;
    result[displayName] = buildSchemaTableDiffFromSnapshots(
      displayName,
      source,
      target,
      targetKey,
    );
  }
  return result;
}

export function filterAlignedTableNames(names: string[], search: string): string[] {
  const q = search.trim().toLowerCase();
  if (!q) {
    return names;
  }
  return names.filter((name) => name.toLowerCase().includes(q));
}

export type { SchemaTargetRowStatus } from "./types";

/** 解析结构同步对齐行在目标侧的状态分类 */
export function resolveSchemaTargetRowStatus(
  name: string,
  schemaDiffs: Record<string, SchemaTableDiff>,
  sourcePresent: boolean,
  targetPresent: boolean,
): SchemaTargetRowStatus | null {
  if (!targetPresent && sourcePresent) {
    return "new";
  }
  if (targetPresent && !sourcePresent) {
    return "targetOnly";
  }
  const status = schemaDiffs[name]?.status;
  if (status === "match" || status === "diff" || status === "new") {
    return status;
  }
  return null;
}

export function filterAlignedTableNamesByStatus(
  names: string[],
  filters: SchemaTargetRowStatus[],
  schemaDiffs: Record<string, SchemaTableDiff>,
  sourcePresent: (name: string) => boolean,
  targetPresent: (name: string) => boolean,
): string[] {
  if (isSchemaTargetStatusFilterShowAll(filters)) {
    return names;
  }
  const filterSet = new Set(filters);
  return names.filter((name) => {
    const status = resolveSchemaTargetRowStatus(
      name,
      schemaDiffs,
      sourcePresent(name),
      targetPresent(name),
    );
    return status !== null && filterSet.has(status);
  });
}
