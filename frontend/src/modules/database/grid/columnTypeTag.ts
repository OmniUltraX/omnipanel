import { detectCellEditorKind, type CellEditorKind } from "../cell_editor";

export function resolveColumnTypeTagKind(rawType: string): CellEditorKind {
  return detectCellEditorKind(rawType);
}

export function columnTypeTagClassName(rawType: string): string {
  const kind = resolveColumnTypeTagKind(rawType);
  return `db-data-table-th-header__type-tag db-data-table-th-header__type-tag--${kind}`;
}
