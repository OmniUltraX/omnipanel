import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { RuleGroupType, RuleType } from "react-querybuilder";
import { Button } from "../../../components/ui/primitives/Button";
import { useI18n } from "../../../i18n";
import type { DbColumnMeta } from "../api";
import type { TableSchema } from "../types";
import type { TableColumnRelation } from "./tableColumnRelation";
import { isRelationDisplayColumn } from "./tableColumnRelation";
import {
  buildFilterFields,
  buildPreviewFilterFields,
  ensureTableFilterQuery,
  extractColumnFilter,
  isTableFilterActive,
  mergeColumnFilter,
  TABLE_FILTER_ALL_COLUMNS,
} from "./tablePreviewFilter";
import type { SortState, SortStates } from "../workspace/dbWorkspaceState";
import { normalizeSortStates } from "../workspace/dbWorkspaceState";

type DraftRule = {
  id: string;
  field: string;
  operator: string;
  value: string | boolean;
  disabled: boolean;
};

type FilterFieldOption = {
  name: string;
  label: string;
  /** 列类型映射的输入控件：number/date/datetime-local/checkbox/text/bigint */
  inputType: string;
};

const OPERATORS = [
  "=",
  "!=",
  "contains",
  "doesNotContain",
  ">",
  ">=",
  "<",
  "<=",
  "null",
  "notNull",
] as const;

function operatorNeedsValue(operator: string): boolean {
  return operator !== "null" && operator !== "notNull";
}

function flattenLeafRules(group: RuleGroupType | null | undefined): RuleType[] {
  const out: RuleType[] = [];
  const walk = (node: RuleGroupType) => {
    for (const rule of node.rules) {
      if (typeof rule === "string") continue;
      if ("rules" in rule) {
        walk(rule);
      } else {
        out.push({ ...rule });
      }
    }
  };
  walk(ensureTableFilterQuery(group));
  return out;
}

function toDraftRule(rule: RuleType, fallbackField: string, id: string): DraftRule {
  const field = rule.field != null ? String(rule.field) : fallbackField;
  const operator = typeof rule.operator === "string" && rule.operator ? rule.operator : "=";
  const raw = (rule as { value?: unknown }).value;
  return {
    id,
    field: field || fallbackField,
    operator: (OPERATORS as readonly string[]).includes(operator) ? operator : "=",
    value:
      typeof raw === "boolean"
        ? raw
        : raw === null || raw === undefined
          ? ""
          : String(raw),
    disabled: Boolean((rule as { disabled?: boolean }).disabled),
  };
}

/** 值输入控件：随列类型变化（数字/日期/布尔复选框等），包含类操作符固定文本 */
function FilterValueInput({
  inputType,
  operator,
  value,
  disabled,
  onChange,
  onEnter,
}: {
  inputType: string;
  operator: string;
  value: string | boolean;
  disabled: boolean;
  onChange: (value: string | boolean) => void;
  onEnter: () => void;
}) {
  const { t } = useI18n();
  if (inputType === "checkbox") {
    return (
      <input
        className="db-qf-value--check"
        type="checkbox"
        checked={value === true || value === "true"}
        disabled={disabled}
        aria-label={t("database.results.filterValue")}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  }
  // BIGINT 用文本保持精度；包含搜索固定文本；其余沿用列类型
  const resolvedType =
    operator === "contains" || operator === "doesNotContain"
      ? "text"
      : inputType === "bigint" || inputType == null
        ? "text"
        : inputType;
  return (
    <input
      className="db-qf-value"
      type={resolvedType}
      value={typeof value === "boolean" ? String(value) : (value ?? "")}
      disabled={disabled}
      placeholder={t("database.results.filterValuePlaceholder")}
      aria-label={t("database.results.filterValue")}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onEnter();
      }}
    />
  );
}

function FunnelIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M2.5 3.5h11l-4 4.5v3.5L6.5 13V8z" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M3.5 4.5h9M6 4.5V3.5h4v1" strokeLinecap="round" />
      <path d="M5.5 4.5l.5 8h4l.5-8" strokeLinejoin="round" />
    </svg>
  );
}

function EyeIcon({ off }: { off?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      {off ? (
        <path d="M3 3l10 10M6.5 6.7A2 2 0 0 0 9.3 9.5M4.5 4.8C3 6 2 8 2 8s2.5 4 6 4c1 0 1.9-.3 2.7-.7M7 5.2C7.3 5.1 7.7 5 8 5c3.5 0 6 3 6 3s-.6 1-1.8 2" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="M2 8s2.5-4 6-4c3.5 0 6 4 6 4s-2.5 4-6 4c-3.5 0-6-4-6-4Z" strokeLinejoin="round" />
      )}
      {!off ? <circle cx="8" cy="8" r="1.6" /> : null}
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
    </svg>
  );
}

export function TableDataGridFilterPopover({
  anchorRect,
  columnMeta,
  columnRelations = {},
  relationTables,
  initialQuery,
  lockedField,
  onApply,
  onClose,
}: {
  anchorRect: DOMRect;
  columnMeta: DbColumnMeta[];
  columnRelations?: Record<string, TableColumnRelation>;
  relationTables?: TableSchema[];
  initialQuery: RuleGroupType | null;
  lockedField: string;
  onApply: (query: RuleGroupType | null) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const idSeq = useRef(0);
  const isTableWide = lockedField === TABLE_FILTER_ALL_COLUMNS;

  const fields = useMemo<FilterFieldOption[]>(() => {
    const toOption = (f: { name: unknown; label?: unknown; inputType?: unknown }) => ({
      name: String(f.name),
      label: String(f.label ?? f.name),
      inputType: typeof f.inputType === "string" && f.inputType ? f.inputType : "text",
    });
    if (isTableWide) {
      return buildPreviewFilterFields(columnMeta, columnRelations, relationTables).map(toOption);
    }
    if (isRelationDisplayColumn(lockedField)) {
      return buildPreviewFilterFields([], columnRelations, relationTables)
        .filter((field) => field.name === lockedField)
        .map(toOption);
    }
    return buildFilterFields(columnMeta.filter((col) => col.name === lockedField)).map(toOption);
  }, [columnMeta, columnRelations, relationTables, isTableWide, lockedField]);

  const inputTypeByField = useMemo(
    () => new Map(fields.map((field) => [field.name, field.inputType])),
    [fields],
  );

  const defaultField = fields[0]?.name ?? (isTableWide ? "" : lockedField);

  const buildInitialDraft = useCallback((): DraftRule[] => {
    const source = isTableWide
      ? ensureTableFilterQuery(initialQuery)
      : extractColumnFilter(initialQuery, lockedField);
    const leaves = flattenLeafRules(source).filter((rule) =>
      isTableWide ? true : String(rule.field) === lockedField,
    );
    const drafts = leaves.map((rule) => {
      idSeq.current += 1;
      return toDraftRule(rule, isTableWide ? defaultField : lockedField, `qf-${idSeq.current}`);
    });
    if (drafts.length === 0 && !isTableWide) {
      idSeq.current += 1;
      drafts.push({
        id: `qf-${idSeq.current}`,
        field: lockedField,
        operator: "=",
        value: "",
        disabled: false,
      });
    }
    return drafts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery, isTableWide, lockedField, defaultField]);

  const [draft, setDraft] = useState<DraftRule[]>(buildInitialDraft);

  useEffect(() => {
    setDraft(buildInitialDraft());
  }, [buildInitialDraft]);

  const operatorOptions = useMemo(
    () => [
      { value: "=", label: t("database.results.filterOpEquals") },
      { value: "!=", label: t("database.results.filterOpNotEquals") },
      { value: "contains", label: t("database.results.filterOpContains") },
      { value: "doesNotContain", label: t("database.results.filterOpNotContains") },
      { value: ">", label: t("database.results.filterOpGt") },
      { value: ">=", label: t("database.results.filterOpGte") },
      { value: "<", label: t("database.results.filterOpLt") },
      { value: "<=", label: t("database.results.filterOpLte") },
      { value: "null", label: t("database.results.filterOpIsNull") },
      { value: "notNull", label: t("database.results.filterOpIsNotNull") },
    ],
    [t],
  );

  useEffect(() => {
    const onDoc = (event: globalThis.MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".omni-select-panel")) return;
      onClose();
    };
    const onEsc = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [onClose]);

  const margin = 8;
  const width = Math.min(520, window.innerWidth - margin * 2);
  const left = Math.max(margin, Math.min(window.innerWidth - width - margin, anchorRect.left));
  const top = Math.min(
    Math.max(margin, anchorRect.bottom + 4),
    window.innerHeight - 380 - margin,
  );

  const enabledCount = draft.filter((rule) => !rule.disabled).length;

  const patchRule = useCallback((id: string, patch: Partial<DraftRule>) => {
    setDraft((prev) => prev.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));
  }, []);

  const removeRule = useCallback((id: string) => {
    setDraft((prev) => prev.filter((rule) => rule.id !== id));
  }, []);

  const addRule = useCallback(() => {
    idSeq.current += 1;
    setDraft((prev) => [
      ...prev,
      {
        id: `qf-${idSeq.current}`,
        field: isTableWide ? prev[prev.length - 1]?.field || defaultField : lockedField,
        operator: "=",
        value: "",
        disabled: false,
      },
    ]);
  }, [isTableWide, defaultField, lockedField]);

  const buildGroupFromDraft = useCallback(
    (rules: DraftRule[]): RuleGroupType | null => {
      const active = rules.filter((rule) => !rule.disabled && rule.field);
      if (active.length === 0) return null;
      return ensureTableFilterQuery({
        combinator: "and",
        rules: active.map((rule) => ({
          field: isTableWide ? rule.field : lockedField,
          operator: rule.operator,
          value: operatorNeedsValue(rule.operator) ? rule.value : null,
        })),
      });
    },
    [isTableWide, lockedField],
  );

  const handleApply = useCallback(() => {
    const group = buildGroupFromDraft(draft);
    if (isTableWide) {
      onApply(isTableFilterActive(group) ? group : null);
    } else {
      onApply(mergeColumnFilter(initialQuery, lockedField, group));
    }
    onClose();
  }, [draft, buildGroupFromDraft, isTableWide, onApply, onClose, initialQuery, lockedField]);

  const handleClear = useCallback(() => {
    if (isTableWide) {
      onApply(null);
    } else {
      onApply(mergeColumnFilter(initialQuery, lockedField, null));
    }
    onClose();
  }, [isTableWide, onApply, onClose, initialQuery, lockedField]);

  const handleReset = useCallback(() => {
    setDraft(buildInitialDraft());
  }, [buildInitialDraft]);

  return createPortal(
    <div
      ref={ref}
      className="db-query-filter-popover db-qf-popover"
      style={{ left, top, width }}
      role="dialog"
      aria-label={
        isTableWide
          ? t("database.results.filterTableTitle")
          : t("database.results.filterColumnTitle", { column: lockedField })
      }
    >
      <div className="db-query-filter-popover-header">
        <span className="db-qf-title">
          <FunnelIcon />
          {isTableWide
            ? t("database.results.filterTableTitle")
            : t("database.results.filterColumnTitle", { column: lockedField })}
        </span>
        <button
          type="button"
          className="db-qf-clear"
          onClick={handleClear}
          title={t("database.results.filterClear")}
        >
          <TrashIcon />
          {t("database.results.filterClear")}
        </button>
      </div>
      <div className="db-qf-body">
        {draft.length === 0 ? (
          <div className="db-qf-empty">{t("database.results.filterNoConditions")}</div>
        ) : (
          draft.map((rule, index) => (
            <div key={rule.id}>
              {index > 0 ? <div className="db-qf-and">AND</div> : null}
              <div className={`db-qf-row${rule.disabled ? " is-disabled" : ""}`}>
                <span className="db-qf-drag" aria-hidden>
                  ⋮⋮
                </span>
                {isTableWide ? (
                  <select
                    className="db-qf-select db-qf-field"
                    value={rule.field}
                    disabled={rule.disabled || fields.length === 0}
                    aria-label={t("database.results.filterFields")}
                    onChange={(event) => patchRule(rule.id, { field: event.target.value })}
                  >
                    {fields.map((field) => (
                      <option key={field.name} value={field.name}>
                        {field.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="db-qf-field-label" title={lockedField}>
                    {lockedField}
                  </span>
                )}
                <select
                  className="db-qf-select db-qf-operator"
                  value={rule.operator}
                  disabled={rule.disabled}
                  aria-label={t("database.results.filterOperators")}
                  onChange={(event) => patchRule(rule.id, { operator: event.target.value })}
                >
                  {operatorOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {operatorNeedsValue(rule.operator) ? (
                  <FilterValueInput
                    inputType={
                      inputTypeByField.get(rule.field) ??
                      inputTypeByField.get(lockedField) ??
                      "text"
                    }
                    operator={rule.operator}
                    value={rule.value}
                    disabled={rule.disabled}
                    onChange={(value) => patchRule(rule.id, { value })}
                    onEnter={handleApply}
                  />
                ) : (
                  <span className="db-qf-value--none" />
                )}
                <button
                  type="button"
                  className={`db-qf-icon-btn${rule.disabled ? " is-off" : ""}`}
                  title={t("database.results.filterToggleRule")}
                  aria-label={t("database.results.filterToggleRule")}
                  aria-pressed={!rule.disabled}
                  onClick={() => patchRule(rule.id, { disabled: !rule.disabled })}
                >
                  <EyeIcon off={rule.disabled} />
                </button>
                <button
                  type="button"
                  className="db-qf-icon-btn"
                  title={t("database.results.filterRemoveRule")}
                  aria-label={t("database.results.filterRemoveRule")}
                  onClick={() => removeRule(rule.id)}
                >
                  <CloseIcon />
                </button>
              </div>
            </div>
          ))
        )}
        <button type="button" className="db-qf-add" onClick={addRule}>
          + {t("database.results.filterAddCondition")}
        </button>
      </div>
      <div className="db-query-filter-popover-footer">
        <span className="db-query-filter-popover-count">
          {t("database.results.filterRuleCount", { count: enabledCount })}
        </span>
        <div className="db-query-filter-popover-footer-actions">
          <Button variant="ghost" size="xs" type="button" onClick={handleReset}>
            {t("database.results.filterReset")}
          </Button>
          <Button variant="default" size="xs" type="button" onClick={handleApply}>
            {t("database.results.filterApply")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SortIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M3 4.5h10M3 8h7M3 11.5h4" strokeLinecap="round" />
      <path d="M12 8.5v4M10.5 11.5 12 13l1.5-1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type DraftSortRow = {
  id: string;
  field: string;
  direction: "asc" | "desc";
};

/** 顶栏 ORDER BY 快捷面板：多列排序（数组顺序即优先级），与筛选面板同风格 */
export function TableDataGridSortPopover({
  anchorRect,
  columns,
  initialSort,
  onApply,
  onClose,
}: {
  anchorRect: DOMRect;
  columns: Array<{ name: string; label?: string }>;
  initialSort: SortState | SortStates | null | undefined;
  onApply: (sort: SortStates) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const idSeq = useRef(0);

  const defaultField = columns[0]?.name ?? "";

  const buildInitialRows = useCallback((): DraftSortRow[] => {
    const rows = normalizeSortStates(initialSort).map((entry) => {
      idSeq.current += 1;
      return {
        id: `qs-${idSeq.current}`,
        field: entry.column,
        direction: entry.direction,
      };
    });
    if (rows.length === 0) {
      idSeq.current += 1;
      rows.push({ id: `qs-${idSeq.current}`, field: defaultField, direction: "asc" });
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSort, defaultField]);

  const [rows, setRows] = useState<DraftSortRow[]>(buildInitialRows);

  useEffect(() => {
    setRows(buildInitialRows());
  }, [buildInitialRows]);

  useEffect(() => {
    const onDoc = (event: globalThis.MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      onClose();
    };
    const onEsc = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [onClose]);

  const margin = 8;
  const width = Math.min(400, window.innerWidth - margin * 2);
  const left = Math.max(margin, Math.min(window.innerWidth - width - margin, anchorRect.left));
  const top = Math.min(
    Math.max(margin, anchorRect.bottom + 4),
    window.innerHeight - 300 - margin,
  );

  const patchRow = useCallback((id: string, patch: Partial<DraftSortRow>) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }, []);

  const removeRow = useCallback((id: string) => {
    setRows((prev) => prev.filter((row) => row.id !== id));
  }, []);

  const addRow = useCallback(() => {
    idSeq.current += 1;
    setRows((prev) => [
      ...prev,
      {
        id: `qs-${idSeq.current}`,
        field: prev[prev.length - 1]?.field || defaultField,
        direction: "asc" as const,
      },
    ]);
  }, [defaultField]);

  const handleApply = useCallback(() => {
    const next: SortStates = rows
      .filter((row) => row.field)
      .map((row) => ({ column: row.field, direction: row.direction }));
    onApply(next);
    onClose();
  }, [rows, onApply, onClose]);

  return createPortal(
    <div
      ref={ref}
      className="db-query-filter-popover db-qf-popover"
      style={{ left, top, width }}
      role="dialog"
      aria-label={t("database.tableDetail.sortPanelTitle")}
    >
      <div className="db-query-filter-popover-header">
        <span className="db-qf-title">
          <SortIcon />
          {t("database.tableDetail.sortPanelTitle")}
        </span>
        <button
          type="button"
          className="db-qf-clear"
          onClick={() => {
            onApply([]);
            onClose();
          }}
          title={t("database.results.sortClear")}
        >
          <TrashIcon />
          {t("database.results.sortClear")}
        </button>
      </div>
      <div className="db-qf-body">
        {rows.length === 0 ? (
          <div className="db-qf-empty">{t("database.results.filterNoConditions")}</div>
        ) : (
          rows.map((row, index) => (
            <div key={row.id}>
              {index > 0 ? <div className="db-qf-and">{index + 1}</div> : null}
              <div className="db-qf-row db-qf-row--sort">
                <span className="db-qf-drag" aria-hidden>
                  ⋮⋮
                </span>
                <select
                  className="db-qf-select db-qf-field"
                  value={row.field}
                  aria-label={t("database.results.filterFields")}
                  onChange={(event) => patchRow(row.id, { field: event.target.value })}
                >
                  {columns.map((column) => (
                    <option key={column.name} value={column.name}>
                      {column.label ?? column.name}
                    </option>
                  ))}
                </select>
                <select
                  className="db-qf-select db-qf-operator"
                  value={row.direction}
                  aria-label={t("database.tableDetail.sortDirectionLabel")}
                  onChange={(event) =>
                    patchRow(row.id, { direction: event.target.value === "desc" ? "desc" : "asc" })
                  }
                >
                  <option value="asc">{t("database.results.sortAsc")}</option>
                  <option value="desc">{t("database.results.sortDesc")}</option>
                </select>
                <button
                  type="button"
                  className="db-qf-icon-btn"
                  title={t("database.results.filterRemoveRule")}
                  aria-label={t("database.results.filterRemoveRule")}
                  onClick={() => removeRow(row.id)}
                >
                  <CloseIcon />
                </button>
              </div>
            </div>
          ))
        )}
        <button type="button" className="db-qf-add" onClick={addRow}>
          + {t("database.tableDetail.sortAddRow")}
        </button>
      </div>
      <div className="db-query-filter-popover-footer">
        <span className="db-query-filter-popover-count">
          {t("database.tableDetail.sortCount", { count: rows.filter((row) => row.field).length })}
        </span>
        <div className="db-query-filter-popover-footer-actions">
          <Button variant="ghost" size="xs" type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="default" size="xs" type="button" onClick={handleApply}>
            {t("database.results.filterApply")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
