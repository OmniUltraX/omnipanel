import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { QueryBuilder, type RuleGroupType } from "react-querybuilder";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import type { DbColumnMeta } from "./api";
import { createTableQueryBuilderControlElements } from "./QueryBuilderSelectControls";
import {
  appendFilterRuleForColumn,
  buildFilterFields,
  ensureTableFilterQuery,
  extractColumnFilter,
  forceColumnOnQuery,
  isTableFilterActive,
  mergeColumnFilter,
  TABLE_FILTER_ALL_COLUMNS,
} from "./tablePreviewFilter";

export function TableDataGridFilterPopover({
  anchorRect,
  columnMeta,
  initialQuery,
  lockedField,
  onApply,
  onClose,
}: {
  anchorRect: DOMRect;
  columnMeta: DbColumnMeta[];
  initialQuery: RuleGroupType | null;
  lockedField: string;
  onApply: (query: RuleGroupType | null) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const isTableWide = lockedField === TABLE_FILTER_ALL_COLUMNS;

  const [draft, setDraft] = useState<RuleGroupType>(() =>
    isTableWide ? ensureTableFilterQuery(initialQuery) : extractColumnFilter(initialQuery, lockedField),
  );

  const fields = useMemo(
    () =>
      isTableWide
        ? buildFilterFields(columnMeta)
        : buildFilterFields(columnMeta.filter((col) => col.name === lockedField)),
    [columnMeta, isTableWide, lockedField],
  );

  const controlElements = useMemo(
    () => (isTableWide ? undefined : createTableQueryBuilderControlElements(lockedField)),
    [isTableWide, lockedField],
  );

  useEffect(() => {
    if (isTableWide) {
      setDraft(ensureTableFilterQuery(initialQuery));
      return;
    }
    setDraft((prev) => {
      const prepared = forceColumnOnQuery(prev, lockedField);
      const hasRule = prepared.rules.some(
        (rule) => typeof rule !== "string" && !("rules" in rule),
      );
      if (hasRule) return prepared;
      return appendFilterRuleForColumn(prepared, lockedField);
    });
  }, [initialQuery, isTableWide, lockedField]);

  const handleQueryChange = useCallback(
    (next: RuleGroupType) => {
      setDraft(isTableWide ? ensureTableFilterQuery(next) : forceColumnOnQuery(next, lockedField));
    },
    [isTableWide, lockedField],
  );

  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".omni-select-panel")) return;
      onClose();
    };
    const onEsc = (event: KeyboardEvent) => {
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
  const width = Math.min(480, window.innerWidth - margin * 2);
  const left = Math.max(margin, Math.min(window.innerWidth - width - margin, anchorRect.left));
  const top = Math.min(
    Math.max(margin, anchorRect.bottom + 4),
    window.innerHeight - 340 - margin,
  );

  const translations = useMemo(
    () => ({
      fields: { title: t("database.results.filterFields") },
      operators: { title: t("database.results.filterOperators") },
      value: { title: t("database.results.filterValue") },
      removeRule: { label: t("database.results.filterRemoveRule"), title: t("database.results.filterRemoveRule") },
      removeGroup: { label: t("database.results.filterRemoveGroup"), title: t("database.results.filterRemoveGroup") },
      addRule: { label: t("database.results.filterAddRule"), title: t("database.results.filterAddRule") },
      addGroup: { label: t("database.results.filterAddGroup"), title: t("database.results.filterAddGroup") },
      combinators: { title: t("database.results.filterCombinator") },
    }),
    [t],
  );

  const activeRuleCount = useMemo(() => {
    const countFilterRules = (group: RuleGroupType): number =>
      group.rules.reduce((count, rule) => {
        if (typeof rule === "string") return count;
        if ("rules" in rule) return count + countFilterRules(rule);
        return count + 1;
      }, 0);
    return countFilterRules(draft);
  }, [draft]);

  return createPortal(
    <div
      ref={ref}
      className="db-query-filter-popover"
      style={{ left, top, width }}
      role="dialog"
      aria-label={
        isTableWide
          ? t("database.results.filterTableTitle")
          : t("database.results.filterColumnTitle", { column: lockedField })
      }
    >
      <div className="db-query-filter-popover-header">
        <span className="db-query-filter-popover-title">
          {isTableWide
            ? t("database.results.filterTableTitle")
            : t("database.results.filterColumnTitle", { column: lockedField })}
        </span>
        <span className="db-query-filter-popover-count">
          {t("database.results.filterRuleCount", { count: activeRuleCount })}
        </span>
      </div>
      <div className="db-query-filter-popover-body">
        <QueryBuilder
          fields={fields}
          query={draft}
          onQueryChange={handleQueryChange}
          translations={translations}
          showCombinatorsBetweenRules
          controlElements={controlElements}
          controlClassnames={{
            queryBuilder: "db-query-filter",
            ruleGroup: "db-query-filter-group",
            header: "db-query-filter-group-header",
            body: "db-query-filter-group-body",
            combinators: "db-query-filter-combinators",
            addRule: "db-query-filter-add-rule",
            addGroup: "db-query-filter-add-group",
            rule: "db-query-filter-rule",
            fields: "db-query-filter-field",
            operators: "db-query-filter-operator",
            value: "db-query-filter-value",
            removeRule: "db-query-filter-remove",
            removeGroup: "db-query-filter-remove",
          }}
        />
      </div>
      <div className="db-query-filter-popover-footer">
        <Button
          variant="ghost"
          size="xs"
          type="button"
          onClick={() => {
            if (isTableWide) {
              onApply(null);
            } else {
              onApply(mergeColumnFilter(initialQuery, lockedField, null));
            }
            onClose();
          }}
        >
          {t("database.results.filterClear")}
        </Button>
        <div className="db-query-filter-popover-footer-actions">
          <Button variant="ghost" size="xs" type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="default"
            size="xs"
            type="button"
            onClick={() => {
              if (isTableWide) {
                onApply(isTableFilterActive(draft) ? ensureTableFilterQuery(draft) : null);
              } else {
                const merged = mergeColumnFilter(
                  initialQuery,
                  lockedField,
                  isTableFilterActive(draft) ? ensureTableFilterQuery(draft) : null,
                );
                onApply(merged);
              }
              onClose();
            }}
          >
            {t("database.results.filterApply")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

