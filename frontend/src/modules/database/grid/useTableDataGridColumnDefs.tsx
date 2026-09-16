import { useMemo, type MutableRefObject } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { type DbColumnMeta } from "../api";
import { resolvePreviewRowKey } from "../workspace/dbWorkspaceState";
import {
  buildRelationDisplayColumnLabel,
  isRelationDisplayColumn,
  relationSourceColumn,
  type TableColumnRelation,
} from "./tableColumnRelation";
import { ColumnHeaderLabel } from "./TableDataGridChrome";
import {
  TableDataGridCellContent,
  TableDataGridTransposeFieldCell,
} from "./TableDataGridCellContent";
import {
  COLUMN_MIN_WIDTH,
  ROW_NUM_COL_ID,
  TRANSPOSE_FIELD_COL,
  defaultDataColumnWidth,
} from "./tableDataGridConstants";
import type { TableSchema } from "../types";
import type { CellOverlayAnchor } from "./tableCellPreview";
import type { SortState } from "../workspace/dbWorkspaceState";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export type UseTableDataGridColumnDefsDeps = {
  displayColumns: string[];
  transposed: boolean;
  columnMetaMap: Record<string, DbColumnMeta> | null | undefined;
  columnRelations: Record<string, TableColumnRelation>;
  relationTables: TableSchema[] | undefined;
  t: Translate;
  canFilter: boolean;
  filterColumnNames: Set<string>;
  openFilterPopover: (anchor: HTMLElement | CellOverlayAnchor, lockedField: string) => void;
  enableSort: boolean;
  primarySort: SortState | null;
  handleColumnSortClick: (columnId: string) => void;
  pkCols: DbColumnMeta[];
  pkCount: number;
  autoIncrementPlaceholder: string;
  pageRef: MutableRefObject<number>;
  pageSizeRef: MutableRefObject<number>;
  displayCellOverridesRef: MutableRefObject<
    Record<string, Record<string, unknown>> | undefined
  >;
};

/**
 * 列定义（含 header/cell JSX）——必须为 tsx。
 */
export function useTableDataGridColumnDefs(deps: UseTableDataGridColumnDefsDeps) {
  const {
    displayColumns,
    transposed,
    columnMetaMap,
    columnRelations,
    relationTables,
    t,
    canFilter,
    filterColumnNames,
    openFilterPopover,
    enableSort,
    primarySort,
    handleColumnSortClick,
    pkCols,
    pkCount,
    autoIncrementPlaceholder,
    pageRef,
    pageSizeRef,
    displayCellOverridesRef,
  } = deps;

  const columnDefs = useMemo<ColumnDef<Record<string, unknown>>[]>(
    () => {
      const defs: ColumnDef<Record<string, unknown>>[] = displayColumns.map((col) => {
        const isFieldCol = transposed && col === TRANSPOSE_FIELD_COL;
        const isRelationDisplayCol = !transposed && isRelationDisplayColumn(col);
        const relationSource = isRelationDisplayCol ? relationSourceColumn(col) : null;
        const sourceRelation = relationSource ? columnRelations[relationSource] : undefined;
        const relatedTable = sourceRelation
          ? relationTables?.find((table) => table.name === sourceRelation.tableName)
          : undefined;
        const relationDisplayLabel = sourceRelation
          ? buildRelationDisplayColumnLabel(sourceRelation, relatedTable)
          : col;
        const rowHeaderIndex = transposed ? parseInt(col.replace("__row__", ""), 10) : -1;
        const headerMeta =
          !isFieldCol && !transposed && !isRelationDisplayCol ? columnMetaMap?.[col] : undefined;
        return {
          id: col,
          accessorFn: (row) => row[col],
          header: () => {
            if (isFieldCol) {
              return <span className="db-row-num-header">#</span>;
            }
            if (transposed && !Number.isNaN(rowHeaderIndex)) {
              return (
                <span className="db-row-num-header">
                  {pageRef.current * pageSizeRef.current + rowHeaderIndex + 1}
                </span>
              );
            }
            return (
              <ColumnHeaderLabel
                label={isRelationDisplayCol ? relationDisplayLabel : col}
                meta={headerMeta}
                t={t}
              />
            );
          },
          cell: ({ getValue, row, column }) => {
            const value = getValue();
            if (isFieldCol) {
              const fieldName = String(value ?? "");
              return (
                <TableDataGridTransposeFieldCell
                  fieldName={fieldName}
                  fieldMeta={columnMetaMap?.[fieldName]}
                  canFilter={canFilter}
                  filterColumnNames={filterColumnNames}
                  enableSort={enableSort}
                  sortColumn={primarySort?.column ?? null}
                  sortDirection={primarySort?.direction ?? null}
                  onSortClick={handleColumnSortClick}
                  onOpenFilter={openFilterPopover}
                  t={t}
                />
              );
            }
            const isRowNumCol = column.id === ROW_NUM_COL_ID;
            if (isRowNumCol) {
              return (
                <span className="db-row-num-cell">
                  {pageRef.current * pageSizeRef.current + row.index + 1}
                </span>
              );
            }
            const colMetaForCell = transposed
              ? columnMetaMap?.[String(row.original[TRANSPOSE_FIELD_COL] ?? "")]
              : isRelationDisplayCol
                ? undefined
                : columnMetaMap?.[column.id];
            const rowKey = transposed
              ? String(row.original[TRANSPOSE_FIELD_COL] ?? "")
              : resolvePreviewRowKey(row.original, pkCols);
            const overrideForRow = rowKey
              ? displayCellOverridesRef.current?.[rowKey]
              : undefined;
            const resolvedValue =
              overrideForRow?.[column.id] !== undefined
                ? overrideForRow[column.id]
                : value;
            return (
              <TableDataGridCellContent
                value={resolvedValue}
                row={row.original}
                columnId={column.id}
                colMeta={colMetaForCell}
                overrideForRow={overrideForRow}
                pkCount={pkCount}
                autoIncrementPlaceholder={autoIncrementPlaceholder}
                t={t}
              />
            );
          },
          minSize: isFieldCol ? 80 : COLUMN_MIN_WIDTH,
          size: isFieldCol
            ? 108
            : isRelationDisplayCol
              ? 140
              : defaultDataColumnWidth(
                  headerMeta?.type,
                  headerMeta?.length,
                  headerMeta?.name ?? col,
                ),
        };
      });
      if (!transposed) {
        defs.unshift({
          id: ROW_NUM_COL_ID,
          accessorFn: () => undefined,
          header: () => <span className="db-row-num-header">#</span>,
          cell: ({ row: r }) => (
            <span className="db-row-num-cell">
              {pageRef.current * pageSizeRef.current + r.index + 1}
            </span>
          ),
          minSize: 28,
          size: 36,
          enableResizing: false,
          enableSorting: false,
        });
      }
      return defs;
    },
    [
      displayColumns,
      transposed,
      columnMetaMap,
      columnRelations,
      relationTables,
      t,
      canFilter,
      filterColumnNames,
      openFilterPopover,
      enableSort,
      primarySort,
      handleColumnSortClick,
      pkCols,
      pkCount,
      autoIncrementPlaceholder,
      pageRef,
      pageSizeRef,
      displayCellOverridesRef,
    ],
  );

  return { columnDefs };
}
