/** MySQL / MariaDB：ADD COLUMN 的相对位置 */
export type MysqlAddColumnPosition =
  | { kind: "first" }
  | { kind: "after"; columnName: string }
  | { kind: "none" };

/**
 * 根据源表列顺序，解析待新增列在目标表上的位置。
 * `existingNames`：目标已有列 ∪ 本批次已生成 ADD 的列。
 */
export function resolveMysqlAddColumnPosition(
  sourceColumns: readonly { name: string }[],
  columnName: string,
  existingNames: ReadonlySet<string>,
): MysqlAddColumnPosition {
  const idx = sourceColumns.findIndex((c) => c.name === columnName);
  if (idx < 0) {
    return { kind: "none" };
  }
  for (let i = idx - 1; i >= 0; i -= 1) {
    const prev = sourceColumns[i]?.name;
    if (prev && existingNames.has(prev)) {
      return { kind: "after", columnName: prev };
    }
  }
  return { kind: "first" };
}

export function formatMysqlAddColumnPositionClause(
  position: MysqlAddColumnPosition,
  quoteIdent: (name: string) => string,
): string {
  if (position.kind === "first") {
    return " FIRST";
  }
  if (position.kind === "after") {
    return ` AFTER ${quoteIdent(position.columnName)}`;
  }
  return "";
}
