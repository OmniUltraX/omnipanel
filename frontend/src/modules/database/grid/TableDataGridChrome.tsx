import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { TextInput } from "../../../components/ui/TextInput";
import { ContextMenu, type ContextMenuItem } from "../../../components/ui/menu/ContextMenu";
import { columnTypeTagClassName } from "./columnTypeTag";
import { useI18n } from "../../../i18n";
import { textSearchMatches } from "../../../lib/textSearchMatch";
import type { DbColumnMeta } from "../api";
import type { CellOverlayAnchor } from "./tableCellPreview";
import { resolvePreviewRowKey } from "../workspace/dbWorkspaceState";

export type TableDataGridCellMenuState = {
  x: number;
  y: number;
  rowIndex: number;
  column: string;
  row: Record<string, unknown>;
  value: unknown;
  columnType?: string;
  rowActionsEnabled?: boolean;
};

export function ColumnFilterButton({
  columnName,
  active,
  onOpen,
}: {
  columnName: string;
  active: boolean;
  onOpen: (anchor: HTMLElement, field: string) => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={`db-data-table-filter-btn${active ? " db-data-table-filter-btn--active" : ""}`}
      title={t("database.results.filterColumnHint")}
      aria-label={t("database.results.filterColumnHint")}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(event.currentTarget, columnName);
      }}
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" width="10" height="10" aria-hidden>
        <path d="M2 3h12M4.5 8h7M7 13h2" strokeLinecap="round" />
      </svg>
    </button>
  );
}

export function ColumnSortIndicator({
  active,
  direction,
  onClick,
  title,
}: {
  active: boolean;
  direction: "asc" | "desc" | null;
  onClick: (event: ReactMouseEvent) => void;
  title: string;
}) {
  return (
    <span
      className={`db-data-table-sort-indicator${active ? " db-data-table-sort-indicator--active" : ""}`}
      onClick={onClick}
      title={title}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick(event as unknown as ReactMouseEvent);
        }
      }}
    >
      {direction === "asc" ? (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" width="10" height="10">
          <path d="M8 12V4M4 8l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : direction === "desc" ? (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" width="10" height="10">
          <path d="M8 4v8M4 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" width="10" height="10">
          <path d="M8 13V3M4.5 6.5L8 3l3.5 3.5" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4.5 9.5L8 13l3.5-3.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.5" />
        </svg>
      )}
    </span>
  );
}

export function ColumnHeaderLabel({
  label,
  meta,
  t,
}: {
  label: string;
  meta?: DbColumnMeta;
  t: (key: string) => string;
}) {
  const showNotNull = meta?.nullable === false;
  const typeLabel = meta?.type?.trim();
  return (
    <span className="db-data-table-th-header">
      <span className="db-data-table-th-header__name-row">
        <span className="db-data-table-th-header__name">{label}</span>
        {showNotNull ? (
          <span
            className="db-data-table-th-nullability db-data-table-th-nullability--no"
            title={t("database.results.columnNotNullable")}
          >
            {t("database.results.columnNotNullableShort")}
          </span>
        ) : null}
      </span>
      {typeLabel ? (
        <span className={columnTypeTagClassName(typeLabel)} title={typeLabel}>
          {typeLabel}
        </span>
      ) : null}
    </span>
  );
}

export function TableDataGridCellContextMenu({
  menuOpenRef,
  onPreview,
  onRowEdit,
  onCellSetNull,
  columnMeta,
  cellOverrides,
}: {
  menuOpenRef: MutableRefObject<(state: TableDataGridCellMenuState) => void>;
  onPreview: (
    info: {
      column: string;
      rowIndex: number;
      row: Record<string, unknown>;
      value: unknown;
      columnType?: string;
      anchor: CellOverlayAnchor;
    },
  ) => void;
  onRowEdit?: (info: { rowIndex: number; column: string; row: Record<string, unknown> }) => void;
  onCellSetNull?: (info: { rowIndex: number; column: string; row: Record<string, unknown> }) => void;
  columnMeta?: DbColumnMeta[];
  cellOverrides?: Record<string, Record<string, unknown>>;
}) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<TableDataGridCellMenuState | null>(null);

  useEffect(() => {
    menuOpenRef.current = setMenu;
    return () => {
      menuOpenRef.current = () => {};
    };
  }, [menuOpenRef]);

  const handlePreview = useCallback(() => {
    if (!menu) return;
    onPreview({
      column: menu.column,
      rowIndex: menu.rowIndex,
      row: menu.row,
      value: menu.value,
      columnType: menu.columnType,
      anchor: {
        left: menu.x,
        top: menu.y,
        width: 240,
        height: 28,
      },
    });
    setMenu(null);
  }, [menu, onPreview]);

  const handleEditRow = useCallback(() => {
    if (!menu || !onRowEdit) return;
    onRowEdit({
      rowIndex: menu.rowIndex,
      column: menu.column,
      row: menu.row,
    });
    setMenu(null);
  }, [menu, onRowEdit]);

  const handleSetNull = useCallback(() => {
    if (!menu || !onCellSetNull) return;
    onCellSetNull({
      rowIndex: menu.rowIndex,
      column: menu.column,
      row: menu.row,
    });
    setMenu(null);
  }, [menu, onCellSetNull]);

  const setNullDisabled = useMemo(() => {
    if (!menu || !onCellSetNull) return true;
    const col = columnMeta?.find((item) => item.name === menu.column);
    if (!col || col.isPk) return true;
    const pkCols = (columnMeta ?? []).filter((item) => item.isPk);
    const rowKey = resolvePreviewRowKey(menu.row, pkCols);
    const overrideValue = rowKey ? cellOverrides?.[rowKey]?.[menu.column] : undefined;
    const currentValue = overrideValue !== undefined ? overrideValue : menu.row[menu.column];
    return currentValue == null;
  }, [menu, onCellSetNull, columnMeta, cellOverrides]);

  const items = useMemo(() => {
    const list: ContextMenuItem[] = [
      {
        id: "preview",
        label: t("database.results.cellPreviewContextMenu"),
        onClick: handlePreview,
      },
    ];
    if (onRowEdit && menu && menu.rowActionsEnabled !== false) {
      list.push(
        {
          id: "edit-row",
          label: t("database.rowEditor.contextMenu"),
          onClick: handleEditRow,
        },
        {
          id: "set-null",
          label: t("database.cellEditor.setNull"),
          disabled: setNullDisabled,
          onClick: handleSetNull,
        },
      );
    }
    return list;
  }, [t, handlePreview, handleEditRow, handleSetNull, onRowEdit, setNullDisabled, menu]);

  if (!menu) return null;

  return (
    <ContextMenu
      position={{ x: menu.x, y: menu.y }}
      onClose={() => setMenu(null)}
      items={items}
    />
  );
}

export function ColumnVisibilitySidebar({
  columns,
  columnMetaMap,
  hiddenColumns,
  onChange,
  activeColumn,
  onColumnNavigate,
}: {
  columns: string[];
  hiddenColumns: Set<string>;
  onChange: (next: Set<string>) => void;
  columnMetaMap: Record<string, DbColumnMeta> | null;
  activeColumn: string | null;
  onColumnNavigate: (columnName: string) => void;
}) {
  const { t } = useI18n();
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  const q = query.trim();
  const filteredColumns = useMemo(
    () => (q ? columns.filter((c) => textSearchMatches(q, c)) : columns),
    [columns, q],
  );

  const visibleCount = columns.length - hiddenColumns.size;
  const allVisible = columns.length > 0 && visibleCount === columns.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = visibleCount > 0 && visibleCount < columns.length;
    }
  }, [visibleCount, columns.length]);

  const toggleOne = useCallback(
    (name: string) => {
      const next = new Set(hiddenColumns);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      onChange(next);
    },
    [hiddenColumns, onChange],
  );

  const toggleAll = useCallback(() => {
    onChange(allVisible ? new Set(columns) : new Set());
  }, [allVisible, columns, onChange]);

  return (
    <aside
      className="db-data-table-col-sidebar"
      aria-label={t("database.results.columnVisibilityTitle")}
    >
      <div className="db-col-visibility-sidebar-inner">
        <div className="db-col-visibility-popover-header">
          <span className="db-col-visibility-popover-title">
            {t("database.results.columnVisibilityTitle")}
          </span>
        </div>
        <label className="db-col-visibility-popover-select-all">
          <input ref={selectAllRef} type="checkbox" checked={allVisible} onChange={toggleAll} />
          <span>{t("database.results.columnVisibilityToggleAll")}</span>
          <span className="db-col-visibility-popover-select-all-count">
            {t("database.results.columnVisibilitySelected", {
              count: visibleCount,
              total: columns.length,
            })}
          </span>
        </label>
        <div className="db-col-visibility-popover-search">
          <svg
            viewBox="0 0 16 16"
            className="db-col-visibility-popover-search-icon"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            aria-hidden
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" strokeLinecap="round" />
          </svg>
          <TextInput
            copyable={false}
            className="db-col-visibility-popover-search-input"
            placeholder={t("database.results.columnVisibilitySearch")}
            value={query}
            onChange={setQuery}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <ul className="db-col-visibility-popover-list">
          {filteredColumns.length === 0 ? (
            <li className="db-col-visibility-popover-empty">
              {t("database.results.columnVisibilityNoResults")}
            </li>
          ) : (
            filteredColumns.map((name) => {
              const checked = !hiddenColumns.has(name);
              const meta = columnMetaMap?.[name];
              return (
                <li
                  key={name}
                  className={`db-col-visibility-popover-item${activeColumn === name ? " db-col-visibility-popover-item--active" : ""}`}
                  onClick={() => onColumnNavigate(name)}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleOne(name)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span className="db-col-visibility-popover-item-name" title={name}>
                    {name}
                  </span>
                  {meta?.comment?.trim() ? (
                    <span
                      className="db-col-visibility-sidebar-item-comment"
                      title={meta.comment.trim()}
                    >
                      {meta.comment.trim()}
                    </span>
                  ) : null}
                </li>
              );
            })
          )}
        </ul>
      </div>
    </aside>
  );
}
