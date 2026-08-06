import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
import { TablePreviewQuerySqlInput } from "./TablePreviewQuerySqlInput";

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

const WHERE_ORDER_RATIO_KEY = "omnipanel.db.table-query.where-order-ratio.v1";
const DEFAULT_WHERE_RATIO = 0.65;
const MIN_WHERE_RATIO = 0.28;
const MAX_WHERE_RATIO = 0.82;

function readWhereRatio(): number {
  try {
    const raw = localStorage.getItem(WHERE_ORDER_RATIO_KEY);
    if (raw == null) return DEFAULT_WHERE_RATIO;
    const value = Number(raw);
    if (!Number.isFinite(value)) return DEFAULT_WHERE_RATIO;
    return Math.min(MAX_WHERE_RATIO, Math.max(MIN_WHERE_RATIO, value));
  } catch {
    return DEFAULT_WHERE_RATIO;
  }
}

function writeWhereRatio(ratio: number) {
  try {
    localStorage.setItem(WHERE_ORDER_RATIO_KEY, String(ratio));
  } catch {
    // ignore quota / private mode
  }
}

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
  const [whereRatio, setWhereRatio] = useState(readWhereRatio);
  const [resizing, setResizing] = useState(false);
  const whereEditingRef = useRef(false);
  const orderEditingRef = useRef(false);
  const changeMenuRef = useRef<HTMLDivElement>(null);
  const fieldsRef = useRef<HTMLDivElement>(null);
  const whereRatioRef = useRef(whereRatio);
  whereRatioRef.current = whereRatio;

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

  const cancelWhere = useCallback(() => {
    whereEditingRef.current = false;
    setWhereDraft(canonicalWhere);
  }, [canonicalWhere]);

  const cancelOrder = useCallback(() => {
    orderEditingRef.current = false;
    setOrderDraft(canonicalOrder);
  }, [canonicalOrder]);

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!enableFilter) return;
      event.preventDefault();
      const fields = fieldsRef.current;
      if (!fields) return;
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      setResizing(true);

      const onMove = (moveEvent: PointerEvent) => {
        const rect = fields.getBoundingClientRect();
        if (rect.width <= 0) return;
        const next = (moveEvent.clientX - rect.left) / rect.width;
        const clamped = Math.min(MAX_WHERE_RATIO, Math.max(MIN_WHERE_RATIO, next));
        whereRatioRef.current = clamped;
        setWhereRatio(clamped);
      };
      const onUp = (upEvent: PointerEvent) => {
        handle.releasePointerCapture(upEvent.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        setResizing(false);
        writeWhereRatio(whereRatioRef.current);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [enableFilter],
  );

  const activeChangeOption =
    CHANGE_FILTER_OPTIONS.find((option) => option.value === changeRowFilter) ??
    CHANGE_FILTER_OPTIONS[0];

  const orderRatio = 1 - whereRatio;

  return (
    <div className={`db-table-query-bar${resizing ? " is-resizing" : ""}`}>
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

      <div className="db-table-query-fields" ref={fieldsRef}>
        {enableFilter ? (
          <>
            <div
              className="db-table-query-field db-table-query-field--where"
              style={{ flexGrow: whereRatio, flexBasis: 0 }}
            >
              <span className="db-table-query-label">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                  <path d="M2.5 3.5h11l-4 5v3.5l-3 1.5v-5l-4-5z" strokeLinejoin="round" />
                </svg>
                WHERE
              </span>
              <TablePreviewQuerySqlInput
                className="db-table-query-input"
                mode="where"
                dbType={dbType}
                columnMeta={columnMeta}
                value={whereDraft}
                placeholder={t("database.tableDetail.wherePlaceholder")}
                aria-label="WHERE"
                onChange={setWhereDraft}
                onFocusChange={(focused) => {
                  whereEditingRef.current = focused;
                }}
                onCommit={commitWhere}
                onCancel={cancelWhere}
              />
            </div>
            <div
              className="db-table-query-resize"
              role="separator"
              aria-orientation="vertical"
              aria-valuenow={Math.round(whereRatio * 100)}
              aria-valuemin={Math.round(MIN_WHERE_RATIO * 100)}
              aria-valuemax={Math.round(MAX_WHERE_RATIO * 100)}
              aria-label={t("database.tableDetail.resizeWhereOrder")}
              tabIndex={0}
              onPointerDown={handleResizePointerDown}
              onKeyDown={(event) => {
                const step = event.shiftKey ? 0.08 : 0.03;
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  const next = Math.max(MIN_WHERE_RATIO, whereRatioRef.current - step);
                  whereRatioRef.current = next;
                  setWhereRatio(next);
                  writeWhereRatio(next);
                } else if (event.key === "ArrowRight") {
                  event.preventDefault();
                  const next = Math.min(MAX_WHERE_RATIO, whereRatioRef.current + step);
                  whereRatioRef.current = next;
                  setWhereRatio(next);
                  writeWhereRatio(next);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  whereRatioRef.current = MIN_WHERE_RATIO;
                  setWhereRatio(MIN_WHERE_RATIO);
                  writeWhereRatio(MIN_WHERE_RATIO);
                } else if (event.key === "End") {
                  event.preventDefault();
                  whereRatioRef.current = MAX_WHERE_RATIO;
                  setWhereRatio(MAX_WHERE_RATIO);
                  writeWhereRatio(MAX_WHERE_RATIO);
                }
              }}
            >
              <span className="db-table-query-resize__grip" aria-hidden />
            </div>
          </>
        ) : null}
        <div
          className="db-table-query-field db-table-query-field--order"
          style={enableFilter ? { flexGrow: orderRatio, flexBasis: 0 } : undefined}
        >
          <span className="db-table-query-label">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
              <path d="M3 4.5h10M3 8h7M3 11.5h4" strokeLinecap="round" />
              <path d="M12 8.5v4M10.5 11.5 12 13l1.5-1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            ORDER BY
          </span>
          <TablePreviewQuerySqlInput
            className="db-table-query-input"
            mode="order"
            dbType={dbType}
            columnMeta={columnMeta}
            value={orderDraft}
            placeholder={t("database.tableDetail.orderPlaceholder")}
            aria-label="ORDER BY"
            onChange={setOrderDraft}
            onFocusChange={(focused) => {
              orderEditingRef.current = focused;
            }}
            onCommit={commitOrder}
            onCancel={cancelOrder}
          />
        </div>
      </div>
    </div>
  );
}
