import type { DbColumnMeta } from "../api";
import { PENDING_INSERT_ROW_KEY } from "../workspace/dbWorkspaceState";
import { isAutoIncrementColumn } from "../shared/columnMetaUtils";

const OBJECT_DISPLAY_CACHE = new WeakMap<object, string>();
const MAX_INLINE_CELL_TEXT_LENGTH = 512;

function truncateDisplayText(text: string): string {
  if (text.length <= MAX_INLINE_CELL_TEXT_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_INLINE_CELL_TEXT_LENGTH)}…`;
}

export function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") {
    const cached = OBJECT_DISPLAY_CACHE.get(value);
    if (cached !== undefined) {
      return cached;
    }
    const text = truncateDisplayText(JSON.stringify(value));
    OBJECT_DISPLAY_CACHE.set(value, text);
    return text;
  }
  const text = String(value);
  return text.length > MAX_INLINE_CELL_TEXT_LENGTH ? truncateDisplayText(text) : text;
}

export function isNullCellValue(value: unknown): boolean {
  return value === null || value === undefined;
}

export function formatCellDisplayText(
  value: unknown,
  opts: {
    row: Record<string, unknown>;
    columnId: string;
    colMeta: DbColumnMeta | undefined;
    overrideForRow: Record<string, unknown> | undefined;
    pkCount: number;
    autoIncrementPlaceholder: string;
  },
): string {
  const isPendingInsert = typeof opts.row[PENDING_INSERT_ROW_KEY] === "string";
  if (
    isPendingInsert &&
    opts.colMeta &&
    isAutoIncrementColumn(opts.colMeta, opts.pkCount) &&
    opts.overrideForRow?.[opts.columnId] === undefined
  ) {
    return opts.autoIncrementPlaceholder;
  }
  return cellToText(value);
}

export function buildColumnHeaderTooltip(
  meta: DbColumnMeta | undefined,
  columnName: string,
  t: (key: string) => string,
): string {
  const lines: string[] = [columnName];
  if (meta?.type) {
    lines.push(meta.type);
  }
  const comment = meta?.comment?.trim();
  if (comment) {
    lines.push(comment);
  }
  if (meta !== undefined && meta.nullable !== undefined) {
    lines.push(
      meta.nullable
        ? t("database.results.columnNullable")
        : t("database.results.columnNotNullable"),
    );
  }
  return lines.join("\n");
}
