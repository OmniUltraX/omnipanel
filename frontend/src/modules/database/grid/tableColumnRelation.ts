import type { TableSchema } from "../types";
import type { TableColumnRelationConfig } from "../workspace/dbWorkspaceState";

/** 列关联配置：当前列值对应的目标表与字段 */
export type TableColumnRelation = TableColumnRelationConfig;

const RELATION_DISPLAY_COLUMN_PREFIX = "__rel__:";

export function relationDisplayColumnId(sourceColumn: string): string {
  return `${RELATION_DISPLAY_COLUMN_PREFIX}${sourceColumn}`;
}

export function isRelationDisplayColumn(columnId: string): boolean {
  return columnId.startsWith(RELATION_DISPLAY_COLUMN_PREFIX);
}

export function relationSourceColumn(columnId: string): string | null {
  if (!isRelationDisplayColumn(columnId)) return null;
  return columnId.slice(RELATION_DISPLAY_COLUMN_PREFIX.length);
}

export function defaultRelationDisplayField(table: TableSchema | undefined | null): string {
  const pk = table?.columns.find((column) => column.isPK);
  return pk?.name ?? "id";
}

export function resolveRelationDisplayFieldName(
  relation: TableColumnRelation,
  table: TableSchema | undefined,
): string {
  const trimmed = relation.displayFieldName?.trim();
  if (trimmed) return trimmed;
  return defaultRelationDisplayField(table);
}

export function buildRelationDisplayColumnLabel(
  relation: TableColumnRelation,
  table: TableSchema | undefined,
): string {
  const trimmedAlias = relation.alias?.trim();
  if (trimmedAlias) return trimmedAlias;
  const displayField = resolveRelationDisplayFieldName(relation, table);
  return `${relation.tableName}.${displayField}`;
}

export function expandColumnsWithRelations(
  columns: string[],
  relations: Record<string, TableColumnRelation>,
): string[] {
  if (Object.keys(relations).length === 0) return columns;
  const expanded: string[] = [];
  for (const column of columns) {
    expanded.push(column);
    if (relations[column]) {
      expanded.push(relationDisplayColumnId(column));
    }
  }
  return expanded;
}

export function formatColumnRelationLabel(
  relation: TableColumnRelation | undefined,
  table?: TableSchema,
): string {
  if (!relation?.tableName || !relation.fieldName) return "";
  const displayField = resolveRelationDisplayFieldName(relation, table ?? undefined);
  return `${relation.tableName}.${relation.fieldName} → ${displayField}`;
}
