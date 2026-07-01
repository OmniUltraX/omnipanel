import type { DbColumnMeta, DbIndexMeta } from "../api";

export type SchemaColumnDiffKind = "added" | "removed" | "changed";

export interface SchemaColumnDiff {
  name: string;
  kind: SchemaColumnDiffKind;
  sourceType?: string;
  targetType?: string;
}

export interface SchemaIndexDiff {
  name: string;
  kind: SchemaColumnDiffKind;
  sourceDetail?: string;
  targetDetail?: string;
}

export type SchemaTableDiffStatus = "checking" | "new" | "match" | "diff" | "error";

export interface SchemaTableDiff {
  tableName: string;
  status: SchemaTableDiffStatus;
  columns: SchemaColumnDiff[];
  indexes: SchemaIndexDiff[];
  error?: string;
  /** 对比所依据的目标库标识，用于缓存失效 */
  targetKey?: string;
  /** 对比所依据的源表结构签名，用于缓存失效 */
  sourceKey?: string;
}

function columnSignature(col: DbColumnMeta): string {
  return `${col.type}|${col.isPk}|${col.isFk}`;
}

function indexSignature(idx: DbIndexMeta): string {
  return `${idx.unique}|${idx.columns.join("\x1f")}`;
}

export function formatIndexDetail(idx: DbIndexMeta): string {
  const cols = idx.columns.join(", ");
  return idx.unique ? `UNIQUE (${cols})` : `(${cols})`;
}

export function compareTableColumns(
  source: DbColumnMeta[],
  target: DbColumnMeta[],
): SchemaColumnDiff[] {
  const diffs: SchemaColumnDiff[] = [];
  const targetByName = new Map(target.map((c) => [c.name, c]));
  const sourceByName = new Map(source.map((c) => [c.name, c]));

  for (const sc of source) {
    const tc = targetByName.get(sc.name);
    if (!tc) {
      diffs.push({ name: sc.name, kind: "added", sourceType: sc.type });
    } else if (columnSignature(sc) !== columnSignature(tc)) {
      diffs.push({
        name: sc.name,
        kind: "changed",
        sourceType: sc.type,
        targetType: tc.type,
      });
    }
  }

  for (const tc of target) {
    if (!sourceByName.has(tc.name)) {
      diffs.push({ name: tc.name, kind: "removed", targetType: tc.type });
    }
  }

  return diffs.sort((a, b) => a.name.localeCompare(b.name));
}

export function compareTableIndexes(
  source: DbIndexMeta[],
  target: DbIndexMeta[],
): SchemaIndexDiff[] {
  const diffs: SchemaIndexDiff[] = [];
  const targetByName = new Map(target.map((i) => [i.name, i]));
  const sourceByName = new Map(source.map((i) => [i.name, i]));

  for (const si of source) {
    const ti = targetByName.get(si.name);
    if (!ti) {
      diffs.push({ name: si.name, kind: "added", sourceDetail: formatIndexDetail(si) });
    } else if (indexSignature(si) !== indexSignature(ti)) {
      diffs.push({
        name: si.name,
        kind: "changed",
        sourceDetail: formatIndexDetail(si),
        targetDetail: formatIndexDetail(ti),
      });
    }
  }

  for (const ti of target) {
    if (!sourceByName.has(ti.name)) {
      diffs.push({ name: ti.name, kind: "removed", targetDetail: formatIndexDetail(ti) });
    }
  }

  return diffs.sort((a, b) => a.name.localeCompare(b.name));
}

export function sourceColumnsSignature(columns: DbColumnMeta[]): string {
  return columns.map((c) => `${c.name}|${c.type}|${c.isPk}|${c.isFk}`).join(",");
}

export function sourceTableSchemaSignature(
  columns: DbColumnMeta[],
  indexes: DbIndexMeta[] = [],
): string {
  const colPart = sourceColumnsSignature(columns);
  const idxPart = [...indexes]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((i) => `${i.name}|${i.unique}|${i.columns.join(":")}`)
    .join(",");
  return `${colPart}#${idxPart}`;
}

export function buildNewTableDiff(
  tableName: string,
  sourceColumns: DbColumnMeta[],
  sourceIndexes: DbIndexMeta[] = [],
): SchemaTableDiff {
  return {
    tableName,
    status: "new",
    columns: sourceColumns.map((c) => ({
      name: c.name,
      kind: "added" as const,
      sourceType: c.type,
    })),
    indexes: sourceIndexes.map((idx) => ({
      name: idx.name,
      kind: "added" as const,
      sourceDetail: formatIndexDetail(idx),
    })),
    sourceKey: sourceTableSchemaSignature(sourceColumns, sourceIndexes),
  };
}

export function hasSchemaDiff(diff: Pick<SchemaTableDiff, "columns" | "indexes">): boolean {
  return diff.columns.length > 0 || diff.indexes.length > 0;
}
