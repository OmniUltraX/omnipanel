import { memo } from "react";
import type { DbColumnMeta } from "../api";
import { RowEditorDialog } from "../cell_editor";
import { PENDING_INSERT_ROW_KEY } from "./dbWorkspaceState";

export type RowEditState = {
  tabId: string;
  column: string;
  row: Record<string, unknown>;
  isNewRow?: boolean;
} | null;

export interface DatabaseTableEditorHostProps {
  rowEdit: RowEditState;
  tableColumnMeta: Record<string, DbColumnMeta[]>;
  tabDirtyRows: Record<string, Record<string, Record<string, unknown>>>;
  onRowSave: (changes: Record<string, unknown>) => void;
  onRowCancel: () => void;
}

export const DatabaseTableEditorHost = memo(function DatabaseTableEditorHost({
  rowEdit,
  tableColumnMeta,
  tabDirtyRows,
  onRowSave,
  onRowCancel,
}: DatabaseTableEditorHostProps) {
  return (
    <>
      {rowEdit && (() => {
        const colMeta = tableColumnMeta[rowEdit.tabId];
        if (!colMeta?.length) return null;
        const pkCols = colMeta.filter((c) => c.isPk);
        const pendingKey = rowEdit.row[PENDING_INSERT_ROW_KEY];
        const rowKey =
          typeof pendingKey === "string"
            ? pendingKey
            : pkCols.length > 0
              ? pkCols
                  .map((pk) => `${pk.name}=${rowEdit.row[pk.name] == null ? "" : String(rowEdit.row[pk.name])}`)
                  .join("&")
              : "";
        const overrides = rowKey ? tabDirtyRows[rowEdit.tabId]?.[rowKey] : undefined;
        return (
          <RowEditorDialog
            open
            mode={rowEdit.isNewRow ? "insert" : "edit"}
            columnMeta={colMeta}
            row={rowEdit.row}
            focusColumn={rowEdit.column}
            overrides={overrides}
            onSave={onRowSave}
            onCancel={onRowCancel}
          />
        );
      })()}
    </>
  );
});
