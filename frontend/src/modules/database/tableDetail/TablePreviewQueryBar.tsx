import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import type { DbColumnMeta } from "../api";
import type { SortState } from "../workspace/dbWorkspaceState";
import type { RuleGroupType } from "react-querybuilder";
import {
  buildOrderByClauseText,
  buildWhereClauseText,
  parseOrderByClauseText,
  parseWhereClauseText,
} from "../grid/tablePreviewFilterSql";
import { showToast } from "../../../stores/toastStore";
import type { TableDetailTab } from "./TableDetailPanel";

export interface TablePreviewQueryBarProps {
  dbType: string;
  columnMeta?: DbColumnMeta[];
  filter: RuleGroupType | null;
  sort: SortState | null;
  onFilterChange: (filter: RuleGroupType | null) => void;
  onSortChange: (sort: SortState | null) => void;
  activeDetailTab: TableDetailTab;
  onDetailTabChange: (tab: TableDetailTab) => void;
  enableFilter: boolean;
}

export function TablePreviewQueryBar({
  dbType,
  columnMeta,
  filter,
  sort,
  onFilterChange,
  onSortChange,
  activeDetailTab,
  onDetailTabChange,
  enableFilter,
}: TablePreviewQueryBarProps) {
  const { t } = useI18n();
  const canonicalWhere = buildWhereClauseText(filter, dbType, columnMeta);
  const canonicalOrder = buildOrderByClauseText(sort);

  const [whereDraft, setWhereDraft] = useState(canonicalWhere);
  const [orderDraft, setOrderDraft] = useState(canonicalOrder);
  const whereEditingRef = useRef(false);
  const orderEditingRef = useRef(false);

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

  return (
    <div className="db-table-query-bar">
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
      <div className="db-table-query-detail-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={`db-table-query-detail-tab${activeDetailTab === "record" ? " is-active" : ""}`}
          aria-selected={activeDetailTab === "record"}
          onClick={() => onDetailTabChange("record")}
        >
          {t("database.tableDetail.recordTab")}
        </button>
        <button
          type="button"
          role="tab"
          className={`db-table-query-detail-tab${activeDetailTab === "value" ? " is-active" : ""}`}
          aria-selected={activeDetailTab === "value"}
          onClick={() => onDetailTabChange("value")}
        >
          {t("database.tableDetail.valueTab")}
        </button>
      </div>
    </div>
  );
}
