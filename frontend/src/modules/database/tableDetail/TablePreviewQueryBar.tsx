import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import type { DbColumnMeta } from "../api";
import type {
  PreviewChangeRowFilter,
  SortState,
} from "../workspace/dbWorkspaceState";
import type { RuleGroupType } from "react-querybuilder";
import {
  buildOrderByClauseText,
  buildWhereClauseText,
  parseOrderByClauseText,
  parseWhereClauseText,
} from "../grid/tablePreviewFilterSql";
import { showToast } from "../../../stores/toastStore";

const CHANGE_FILTER_OPTIONS: Array<{
  value: PreviewChangeRowFilter;
  tone: "default" | "update" | "insert" | "delete";
  labelKey:
    | "database.tableDetail.changeFilterAll"
    | "database.tableDetail.changeFilterChanged"
    | "database.tableDetail.changeFilterUpdate"
    | "database.tableDetail.changeFilterInsert"
    | "database.tableDetail.changeFilterDelete";
}> = [
  { value: "all", tone: "default", labelKey: "database.tableDetail.changeFilterAll" },
  { value: "changed", tone: "default", labelKey: "database.tableDetail.changeFilterChanged" },
  { value: "update", tone: "update", labelKey: "database.tableDetail.changeFilterUpdate" },
  { value: "insert", tone: "insert", labelKey: "database.tableDetail.changeFilterInsert" },
  { value: "delete", tone: "delete", labelKey: "database.tableDetail.changeFilterDelete" },
];

export interface TablePreviewQueryBarProps {
  dbType: string;
  columnMeta?: DbColumnMeta[];
  filter: RuleGroupType | null;
  sort: SortState | null;
  onFilterChange: (filter: RuleGroupType | null) => void;
  onSortChange: (sort: SortState | null) => void;
  enableFilter: boolean;
  changeRowFilter: PreviewChangeRowFilter;
  onChangeRowFilterChange: (filter: PreviewChangeRowFilter) => void;
}

export function TablePreviewQueryBar({
  dbType,
  columnMeta,
  filter,
  sort,
  onFilterChange,
  onSortChange,
  enableFilter,
  changeRowFilter,
  onChangeRowFilterChange,
}: TablePreviewQueryBarProps) {
  const { t } = useI18n();
  const canonicalWhere = buildWhereClauseText(filter, dbType, columnMeta);
  const canonicalOrder = buildOrderByClauseText(sort);

  const [whereDraft, setWhereDraft] = useState(canonicalWhere);
  const [orderDraft, setOrderDraft] = useState(canonicalOrder);
  const [changeMenuOpen, setChangeMenuOpen] = useState(false);
  const whereEditingRef = useRef(false);
  const orderEditingRef = useRef(false);
  const changeMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!whereEditingRef.current) {
      setWhereDraft(canonicalWhere);
    }
  }, [canonicalWhere]);

  useEffect(() => {
    if (!orderEditingRef.current) {
      setOrderDraft(canonicalOrder);
    }
  }, [canonicalOrder]);

  useEffect(() => {
    if (!changeMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!changeMenuRef.current?.contains(event.target as Node)) {
        setChangeMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setChangeMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [changeMenuOpen]);

  const commitWhere = useCallback(() => {
    whereEditingRef.current = false;
    const parsed = parseWhereClauseText(whereDraft, columnMeta);
    if (!parsed.ok) {
      showToast(parsed.error);
      setWhereDraft(canonicalWhere);
      return;
    }
    onFilterChange(parsed.filter);
    setWhereDraft(buildWhereClauseText(parsed.filter, dbType, columnMeta));
  }, [whereDraft, columnMeta, canonicalWhere, onFilterChange, dbType]);

  const commitOrder = useCallback(() => {
    orderEditingRef.current = false;
    const parsed = parseOrderByClauseText(orderDraft);
    if (!parsed.ok) {
      showToast(parsed.error);
      setOrderDraft(canonicalOrder);
      return;
    }
    onSortChange(parsed.sort);
    setOrderDraft(buildOrderByClauseText(parsed.sort));
  }, [orderDraft, canonicalOrder, onSortChange]);

  const activeChangeOption =
    CHANGE_FILTER_OPTIONS.find((option) => option.value === changeRowFilter) ??
    CHANGE_FILTER_OPTIONS[0];

  return (
    <div className="db-table-query-bar">
      <div className="db-table-query-change" ref={changeMenuRef}>
        <button
          type="button"
          className={`db-table-query-change-trigger db-table-query-change-trigger--${activeChangeOption.tone}${changeRowFilter !== "all" ? " is-active" : ""}`}
          aria-haspopup="listbox"
          aria-expanded={changeMenuOpen}
          onClick={() => setChangeMenuOpen((open) => !open)}
        >
          <span>{t(activeChangeOption.labelKey)}</span>
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden>
            <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {changeMenuOpen ? (
          <div className="db-table-query-change-menu" role="listbox">
            {CHANGE_FILTER_OPTIONS.map((option) => {
              const selected = option.value === changeRowFilter;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`db-table-query-change-option db-table-query-change-option--${option.tone}${selected ? " is-selected" : ""}`}
                  onClick={() => {
                    onChangeRowFilterChange(option.value);
                    setChangeMenuOpen(false);
                  }}
                >
                  <span>{t(option.labelKey)}</span>
                  {selected ? (
                    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
                      <path
                        d="M2.5 6.2 4.8 8.5 9.5 3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
      {enableFilter ? (
        <label className="db-table-query-field db-table-query-field--where">
          <span className="db-table-query-label">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
              <path d="M2.5 3.5h11l-4 5v3.5l-3 1.5v-5l-4-5z" strokeLinejoin="round" />
            </svg>
            WHERE
          </span>
          <input
            className="db-table-query-input"
            value={whereDraft}
            placeholder={t("database.tableDetail.wherePlaceholder")}
            spellCheck={false}
            onFocus={() => {
              whereEditingRef.current = true;
            }}
            onChange={(e) => setWhereDraft(e.target.value)}
            onBlur={commitWhere}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
              if (e.key === "Escape") {
                whereEditingRef.current = false;
                setWhereDraft(canonicalWhere);
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        </label>
      ) : null}
      <label className="db-table-query-field db-table-query-field--order">
        <span className="db-table-query-label">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
            <path d="M3 4.5h10M3 8h7M3 11.5h4" strokeLinecap="round" />
            <path d="M12 8.5v4M10.5 11.5 12 13l1.5-1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          ORDER BY
        </span>
        <input
          className="db-table-query-input"
          value={orderDraft}
          placeholder={t("database.tableDetail.orderPlaceholder")}
          spellCheck={false}
          onFocus={() => {
            orderEditingRef.current = true;
          }}
          onChange={(e) => setOrderDraft(e.target.value)}
          onBlur={commitOrder}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === "Escape") {
              orderEditingRef.current = false;
              setOrderDraft(canonicalOrder);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
      </label>
    </div>
  );
}
