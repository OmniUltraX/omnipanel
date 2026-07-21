import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from "react";
import { TextInput } from "../../../components/ui/TextInput";
import { ContextMenu, type ContextMenuItem } from "../../../components/ui/menu/ContextMenu";
import { columnTypeTagClassName } from "./columnTypeTag";
import { useI18n } from "../../../i18n";
import { textSearchMatches } from "../../../lib/textSearchMatch";
import type { DbColumnMeta } from "../api";

export type TableDataGridCellMenuState = {
  x: number;
  y: number;
  rowIndex: number;
  /** 网格 leaf 列下标（含行号列） */
  colIndex: number;
  column: string;
  row: Record<string, unknown>;
  value: unknown;
  columnType?: string;
  rowActionsEnabled?: boolean;
};

export function ColumnRelationButton({
  columnName,
  active,
  relationLabel,
  onOpen,
}: {
  columnName: string;
  active: boolean;
  relationLabel?: string;
  onOpen: (columnName: string) => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className={`db-data-table-relation-btn${active ? " db-data-table-relation-btn--active" : ""}`}
      title={
        active && relationLabel
          ? t("database.results.relationColumnHintActive", { target: relationLabel })
          : t("database.results.relationColumnHint")
      }
      aria-label={t("database.results.relationColumnHint")}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(columnName);
      }}
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" width="10" height="10" aria-hidden>
        <path d="M6.5 3.5h6a1 1 0 0 1 1 1v6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M9.5 6.5H3.5a1 1 0 0 0-1 1v6" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M10.5 2.5 13 5M5 11l2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

export function ColumnRelationDisplayActions({
  onEdit,
  onDelete,
}: {
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  return (
    <span className="db-data-table-relation-display-actions">
      <button
        type="button"
        className="db-data-table-relation-display-btn"
        title={t("database.results.relationEdit")}
        aria-label={t("database.results.relationEdit")}
        onClick={(event) => {
          event.stopPropagation();
          onEdit();
        }}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" width="10" height="10" aria-hidden>
          <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" strokeLinejoin="round" />
        </svg>
      </button>
      <button
        type="button"
        className="db-data-table-relation-display-btn db-data-table-relation-display-btn--danger"
        title={t("database.results.relationDelete")}
        aria-label={t("database.results.relationDelete")}
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" width="10" height="10" aria-hidden>
          <path d="M3 4.5h10M6 4.5V3.5h4v1M6.5 7v4M9.5 7v4M4.5 4.5l.5 8h6l.5-8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </span>
  );
}

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
  buildItems,
}: {
  menuOpenRef: MutableRefObject<(state: TableDataGridCellMenuState) => void>;
  buildItems: (menu: TableDataGridCellMenuState) => ContextMenuItem[];
}) {
  const [menu, setMenu] = useState<TableDataGridCellMenuState | null>(null);

  useEffect(() => {
    menuOpenRef.current = setMenu;
    return () => {
      menuOpenRef.current = () => {};
    };
  }, [menuOpenRef]);

  const items = useMemo(() => (menu ? buildItems(menu) : []), [menu, buildItems]);

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
  columnLabels,
  isColumnVisible,
  columnItemClassName,
}: {
  columns: string[];
  hiddenColumns: Set<string>;
  onChange: (next: Set<string>) => void;
  columnMetaMap: Record<string, DbColumnMeta> | null;
  activeColumn: string | null;
  onColumnNavigate: (columnName: string) => void;
  columnLabels?: Record<string, string>;
  isColumnVisible?: (columnName: string) => boolean;
  columnItemClassName?: (columnName: string) => string | undefined;
}) {
  const { t } = useI18n();
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");

  const q = query.trim();
  const filteredColumns = useMemo(
    () => (q ? columns.filter((c) => textSearchMatches(q, columnLabels?.[c] ?? c)) : columns),
    [columns, columnLabels, q],
  );

  const resolveVisible = useCallback(
    (name: string) => (isColumnVisible ? isColumnVisible(name) : !hiddenColumns.has(name)),
    [hiddenColumns, isColumnVisible],
  );

  const visibleCount = columns.filter((name) => resolveVisible(name)).length;
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
              const checked = resolveVisible(name);
              const meta = columnMetaMap?.[name];
              const label = columnLabels?.[name] ?? name;
              const itemClassName = columnItemClassName?.(name);
              return (
                <li
                  key={name}
                  className={[
                    "db-col-visibility-popover-item",
                    activeColumn === name ? "db-col-visibility-popover-item--active" : "",
                    itemClassName,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => onColumnNavigate(name)}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleOne(name)}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <span className="db-col-visibility-popover-item-name" title={label}>
                    {label}
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
