import type { DbColumnMeta } from "../api";
import { ColumnFilterButton, ColumnSortIndicator } from "./TableDataGridChrome";
import { formatCellDisplayText, isNullCellValue } from "./tableDataGridFormat";
import { ROW_NUM_COL_ID } from "./tableDataGridConstants";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function TableDataGridTransposeFieldCell({
  fieldName,
  fieldMeta,
  canFilter,
  filterColumnNames,
  enableSort,
  sortColumn,
  sortDirection,
  onSortClick,
  onOpenFilter,
  t,
}: {
  fieldName: string;
  fieldMeta?: DbColumnMeta;
  canFilter: boolean;
  filterColumnNames: ReadonlySet<string>;
  enableSort: boolean;
  sortColumn: string | null;
  sortDirection: "asc" | "desc" | null;
  onSortClick: (fieldName: string) => void;
  onOpenFilter: (anchor: HTMLElement, field: string) => void;
  t: Translate;
}) {
  const fieldFiltered = canFilter && filterColumnNames.has(fieldName);
  const fieldSortActive = enableSort && sortColumn === fieldName;
  return (
    <span className="db-data-table-field-inner">
      <span className="db-data-table-th-label-wrap">
        <span className="db-data-table-cell-text">{fieldName}</span>
        {fieldMeta?.nullable === false ? (
          <span
            className="db-data-table-th-nullability db-data-table-th-nullability--no"
            title={t("database.results.columnNotNullable")}
          >
            {t("database.results.columnNotNullableShort")}
          </span>
        ) : null}
      </span>
      {enableSort ? (
        <ColumnSortIndicator
          active={fieldSortActive}
          direction={fieldSortActive ? sortDirection : null}
          title={t("database.results.sortHint")}
          onClick={(event) => {
            event.stopPropagation();
            onSortClick(fieldName);
          }}
        />
      ) : null}
      {canFilter ? (
        <ColumnFilterButton
          columnName={fieldName}
          active={fieldFiltered}
          onOpen={onOpenFilter}
        />
      ) : null}
    </span>
  );
}

export function TableDataGridCellContent({
  value,
  row,
  columnId,
  colMeta,
  overrideForRow,
  pkCount,
  autoIncrementPlaceholder,
  t,
}: {
  value: unknown;
  row: Record<string, unknown>;
  columnId: string;
  colMeta: DbColumnMeta | undefined;
  overrideForRow: Record<string, unknown> | undefined;
  pkCount: number;
  autoIncrementPlaceholder: string;
  t: Translate;
}) {
  if (columnId === ROW_NUM_COL_ID) {
    return null;
  }

  const displayText = formatCellDisplayText(value, {
    row,
    columnId,
    colMeta,
    overrideForRow,
    pkCount,
    autoIncrementPlaceholder,
  });
  const isAutoIncrementPlaceholder = displayText === autoIncrementPlaceholder;
  const isNullValue = !isAutoIncrementPlaceholder && isNullCellValue(value);

  if (isNullValue) {
    return (
      <span className="db-data-table-cell-null-tag">
        {t("database.results.columnNullableShort")}
      </span>
    );
  }

  return (
    <span
      className={`db-data-table-cell-text${isAutoIncrementPlaceholder ? " db-data-table-cell-text--placeholder" : ""}`}
    >
      {displayText}
    </span>
  );
}