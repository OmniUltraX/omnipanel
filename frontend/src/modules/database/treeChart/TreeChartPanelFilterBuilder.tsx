import { useMemo } from "react";
import { QueryBuilder, type RuleGroupType } from "react-querybuilder";
import { useI18n } from "../../../i18n";
import type { ColumnSchema } from "../types";
import { tableQueryBuilderControlElements } from "../sql/QueryBuilderSelectControls";
import {
  buildFilterFields,
  ensureTableFilterQuery,
} from "../grid/tablePreviewFilter";

interface TreeChartPanelFilterBuilderProps {
  columns: ColumnSchema[];
  query: RuleGroupType;
  onQueryChange: (query: RuleGroupType) => void;
  disabled?: boolean;
}

export function TreeChartPanelFilterBuilder({
  columns,
  query,
  onQueryChange,
  disabled = false,
}: TreeChartPanelFilterBuilderProps) {
  const { t } = useI18n();

  const fields = useMemo(
    () =>
      buildFilterFields(
        columns.map((column) => ({
          name: column.name,
          type: column.type,
          isPk: column.isPK ?? false,
          isFk: column.isFK ?? false,
          nullable: column.nullable,
          comment: column.comment ?? null,
        })),
      ),
    [columns],
  );

  const translations = useMemo(
    () => ({
      fields: { title: t("database.results.filterFields") },
      operators: { title: t("database.results.filterOperators") },
      value: { title: t("database.results.filterValue") },
      removeRule: {
        label: t("database.results.filterRemoveRule"),
        title: t("database.results.filterRemoveRule"),
      },
      removeGroup: {
        label: t("database.results.filterRemoveGroup"),
        title: t("database.results.filterRemoveGroup"),
      },
      addRule: {
        label: t("database.results.filterAddRule"),
        title: t("database.results.filterAddRule"),
      },
      addGroup: {
        label: t("database.results.filterAddGroup"),
        title: t("database.results.filterAddGroup"),
      },
      combinators: { title: t("database.results.filterCombinator") },
    }),
    [t],
  );

  return (
    <QueryBuilder
      fields={fields}
      query={query}
      onQueryChange={(next) => onQueryChange(ensureTableFilterQuery(next))}
      translations={translations}
      showCombinatorsBetweenRules
      disabled={disabled}
      controlElements={tableQueryBuilderControlElements}
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
  );
}
