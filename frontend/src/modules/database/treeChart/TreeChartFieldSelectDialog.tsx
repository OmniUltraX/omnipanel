import { useEffect, useMemo, useState } from "react";
import type { RuleGroupType } from "react-querybuilder";
import { useI18n } from "../../../i18n";
import { FormDialog, FormField } from "../../../components/ui/FormDialog";
import { Select } from "../../../components/ui/form/Select";
import type { TableSchema } from "../types";
import type {
  TreeChartAssociationMode,
  TreeChartFieldSelection,
} from "./treeChartTypes";
import { resolveTreeChartAssociationMode } from "./treeChartTypes";
import { TreeChartPanelFilterBuilder } from "./TreeChartPanelFilterBuilder";
import {
  EMPTY_TABLE_FILTER,
  ensureTableFilterQuery,
  isTableFilterActive,
} from "../grid/tablePreviewFilter";

interface TreeChartFieldSelectDialogProps {
  open: boolean;
  onClose: () => void;
  tables: TableSchema[];
  isFirstPanel: boolean;
  initial?: Partial<TreeChartFieldSelection> | null;
  title?: string;
  subtitle?: string;
  onConfirm: (selection: TreeChartFieldSelection) => void;
}

const SELECT_CLASS = "setting-select tree-chart-field-select__select";

function fieldsAreDistinct(values: string[]): boolean {
  const trimmed = values.map((value) => value.trim()).filter(Boolean);
  return new Set(trimmed).size === trimmed.length;
}

function defaultJoinField(table: TableSchema | null): string {
  const pk = table?.columns.find((column) => column.isPK);
  return pk?.name ?? "";
}

function columnOptionsFor(table: TableSchema | null) {
  return (table?.columns ?? []).map((column) => ({
    value: column.name,
    label: column.name,
  }));
}

export function TreeChartFieldSelectDialog({
  open,
  onClose,
  tables,
  isFirstPanel,
  initial,
  title,
  subtitle,
  onConfirm,
}: TreeChartFieldSelectDialogProps) {
  const { t } = useI18n();
  const [associationMode, setAssociationMode] = useState<TreeChartAssociationMode>("singleTable");
  const [tableName, setTableName] = useState(initial?.tableName ?? "");
  const [labelField, setLabelField] = useState(initial?.labelField ?? "");
  const [upstreamRelationField, setUpstreamRelationField] = useState(
    initial?.upstreamRelationField ?? "",
  );
  const [downstreamRelationField, setDownstreamRelationField] = useState(
    initial?.downstreamRelationField ??
      (initial as { relationField?: string } | undefined)?.relationField ??
      "",
  );
  const [junctionTableName, setJunctionTableName] = useState(
    initial?.junction?.junctionTableName ?? "",
  );
  const [junctionToUpstreamField, setJunctionToUpstreamField] = useState(
    initial?.junction?.junctionToUpstreamField ?? "",
  );
  const [junctionToDownstreamField, setJunctionToDownstreamField] = useState(
    initial?.junction?.junctionToDownstreamField ?? "",
  );
  const [downstreamTableJoinField, setDownstreamTableJoinField] = useState(
    initial?.junction?.downstreamTableJoinField ?? "",
  );
  const [filterQuery, setFilterQuery] = useState<RuleGroupType>(EMPTY_TABLE_FILTER);

  useEffect(() => {
    if (!open) {
      return;
    }
    const mode = isFirstPanel ? "singleTable" : resolveTreeChartAssociationMode(initial);
    setAssociationMode(mode);
    setTableName(initial?.tableName ?? "");
    setLabelField(initial?.labelField ?? "");
    setUpstreamRelationField(initial?.upstreamRelationField ?? "");
    setDownstreamRelationField(
      initial?.downstreamRelationField ??
        (initial as { relationField?: string } | undefined)?.relationField ??
        "",
    );
    setJunctionTableName(initial?.junction?.junctionTableName ?? "");
    setJunctionToUpstreamField(initial?.junction?.junctionToUpstreamField ?? "");
    setJunctionToDownstreamField(initial?.junction?.junctionToDownstreamField ?? "");
    setDownstreamTableJoinField(initial?.junction?.downstreamTableJoinField ?? "");
    setFilterQuery(
      initial?.filter != null
        ? ensureTableFilterQuery(initial.filter)
        : EMPTY_TABLE_FILTER,
    );
  }, [
    open,
    isFirstPanel,
    initial?.tableName,
    initial?.labelField,
    initial?.upstreamRelationField,
    initial?.downstreamRelationField,
    initial?.junction,
    initial?.filter,
    initial,
  ]);

  const selectedTable = useMemo(
    () => tables.find((table) => table.name === tableName) ?? null,
    [tables, tableName],
  );
  const selectedJunctionTable = useMemo(
    () => tables.find((table) => table.name === junctionTableName) ?? null,
    [tables, junctionTableName],
  );

  const emptyColumnOptions = useMemo(
    () => [{ value: "", label: t("database.treeChart.noColumns"), disabled: true }],
    [t],
  );

  const tableOptions = useMemo(
    () =>
      tables.length > 0
        ? tables.map((table) => ({ value: table.name, label: table.name }))
        : [{ value: "", label: t("database.treeChart.noTables"), disabled: true }],
    [tables, t],
  );

  const isJunctionMode = !isFirstPanel && associationMode === "junctionTable";

  const canConfirm = useMemo(() => {
    if (isJunctionMode) {
      if (
        !junctionTableName ||
        !junctionToUpstreamField ||
        !junctionToDownstreamField ||
        !tableName ||
        !downstreamTableJoinField ||
        !labelField ||
        !downstreamRelationField
      ) {
        return false;
      }
      return (
        fieldsAreDistinct([junctionToUpstreamField, junctionToDownstreamField]) &&
        fieldsAreDistinct([labelField, downstreamRelationField])
      );
    }

    if (!tableName || !labelField || !downstreamRelationField) {
      return false;
    }
    if (isFirstPanel) {
      return fieldsAreDistinct([labelField, downstreamRelationField]);
    }
    if (!upstreamRelationField) {
      return false;
    }
    return fieldsAreDistinct([labelField, upstreamRelationField, downstreamRelationField]);
  }, [
    isJunctionMode,
    junctionTableName,
    junctionToUpstreamField,
    junctionToDownstreamField,
    tableName,
    downstreamTableJoinField,
    labelField,
    downstreamRelationField,
    isFirstPanel,
    upstreamRelationField,
  ]);

  const resetSingleTableFields = () => {
    setLabelField("");
    setUpstreamRelationField("");
    setDownstreamRelationField("");
    setFilterQuery(EMPTY_TABLE_FILTER);
  };

  const resetJunctionFields = () => {
    setJunctionTableName("");
    setJunctionToUpstreamField("");
    setJunctionToDownstreamField("");
    setTableName("");
    setDownstreamTableJoinField("");
    setLabelField("");
    setDownstreamRelationField("");
    setFilterQuery(EMPTY_TABLE_FILTER);
  };

  const optionsFor = (table: TableSchema | null, exclude: string[]) => {
    const options = columnOptionsFor(table);
    return options.length > 0
      ? options.filter((option) => !exclude.includes(option.value))
      : emptyColumnOptions;
  };

  const buildSelection = (): TreeChartFieldSelection => {
    const activeFilter = isTableFilterActive(filterQuery) ? filterQuery : null;
    if (isJunctionMode) {
      return {
        associationMode: "junctionTable",
        tableName,
        labelField,
        downstreamRelationField,
        junction: {
          junctionTableName,
          junctionToUpstreamField,
          junctionToDownstreamField,
          downstreamTableJoinField,
        },
        filter: activeFilter,
      };
    }
    return {
      associationMode: "singleTable",
      tableName,
      labelField,
      downstreamRelationField,
      ...(isFirstPanel ? {} : { upstreamRelationField }),
      filter: activeFilter,
    };
  };

  const filterTable = isJunctionMode ? selectedTable : selectedTable;

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={title ?? t("database.treeChart.selectFieldsTitle")}
      subtitle={
        subtitle ??
        (isFirstPanel
          ? t("database.treeChart.selectFieldsDescFirst")
          : t("database.treeChart.selectFieldsDescSubsequent"))
      }
      size="lg"
      primaryAction={{
        label: t("common.confirm"),
        disabled: !canConfirm,
        onClick: () => {
          if (!canConfirm) {
            return;
          }
          onConfirm(buildSelection());
          onClose();
        },
      }}
    >
      {!isFirstPanel ? (
        <FormField label={t("database.treeChart.associationMode")}>
          <div className="tree-chart-field-select__mode" role="group">
            <button
              type="button"
              className={`tree-chart-field-select__mode-btn${
                associationMode === "singleTable" ? " tree-chart-field-select__mode-btn--active" : ""
              }`}
              onClick={() => {
                setAssociationMode("singleTable");
                resetJunctionFields();
              }}
            >
              {t("database.treeChart.singleTableAssociation")}
            </button>
            <button
              type="button"
              className={`tree-chart-field-select__mode-btn${
                associationMode === "junctionTable"
                  ? " tree-chart-field-select__mode-btn--active"
                  : ""
              }`}
              onClick={() => {
                setAssociationMode("junctionTable");
                resetSingleTableFields();
              }}
            >
              {t("database.treeChart.junctionTableAssociation")}
            </button>
          </div>
        </FormField>
      ) : null}

      {isJunctionMode ? (
        <>
          <FormField label={t("database.treeChart.junctionTable")}>
            <Select
              className={SELECT_CLASS}
              value={junctionTableName}
              onChange={(value) => {
                setJunctionTableName(value);
                setJunctionToUpstreamField("");
                setJunctionToDownstreamField("");
              }}
              options={tableOptions}
              searchable
              placeholder={t("database.treeChart.selectJunctionTable")}
            />
          </FormField>
          <FormField label={t("database.treeChart.junctionToUpstreamField")}>
            <Select
              className={SELECT_CLASS}
              value={junctionToUpstreamField}
              onChange={setJunctionToUpstreamField}
              disabled={!selectedJunctionTable}
              options={optionsFor(selectedJunctionTable, [])}
              searchable
              placeholder={t("database.treeChart.selectJunctionToUpstreamField")}
            />
          </FormField>
          <FormField label={t("database.treeChart.junctionToDownstreamField")}>
            <Select
              className={SELECT_CLASS}
              value={junctionToDownstreamField}
              onChange={setJunctionToDownstreamField}
              disabled={!selectedJunctionTable}
              options={optionsFor(selectedJunctionTable, [junctionToUpstreamField])}
              searchable
              placeholder={t("database.treeChart.selectJunctionToDownstreamField")}
            />
          </FormField>
          <FormField label={t("database.treeChart.downstreamTable")}>
            <Select
              className={SELECT_CLASS}
              value={tableName}
              onChange={(value) => {
                const nextTable = tables.find((table) => table.name === value) ?? null;
                setTableName(value);
                setDownstreamTableJoinField(defaultJoinField(nextTable));
                setLabelField("");
                setDownstreamRelationField("");
                setFilterQuery(EMPTY_TABLE_FILTER);
              }}
              options={tableOptions}
              searchable
              placeholder={t("database.treeChart.selectDownstreamTable")}
            />
          </FormField>
          <FormField
            label={t("database.treeChart.downstreamTableJoinField")}
            hint={t("database.treeChart.downstreamTableJoinFieldHint")}
          >
            <Select
              className={SELECT_CLASS}
              value={downstreamTableJoinField}
              onChange={setDownstreamTableJoinField}
              disabled={!selectedTable}
              options={optionsFor(selectedTable, [])}
              searchable
              placeholder={t("database.treeChart.selectDownstreamTableJoinField")}
            />
          </FormField>
          <FormField label={t("database.treeChart.labelField")}>
            <Select
              className={SELECT_CLASS}
              value={labelField}
              onChange={setLabelField}
              disabled={!selectedTable}
              options={optionsFor(selectedTable, [downstreamRelationField])}
              searchable
              placeholder={t("database.treeChart.selectLabelField")}
            />
          </FormField>
          <FormField
            label={t("database.treeChart.downstreamRelationField")}
            hint={t("database.treeChart.downstreamRelationFieldHintJunction")}
          >
            <Select
              className={SELECT_CLASS}
              value={downstreamRelationField}
              onChange={setDownstreamRelationField}
              disabled={!selectedTable}
              options={optionsFor(selectedTable, [labelField])}
              searchable
              placeholder={t("database.treeChart.selectDownstreamRelationField")}
            />
          </FormField>
        </>
      ) : (
        <>
          <FormField label={t("database.treeChart.table")}>
            <Select
              className={SELECT_CLASS}
              value={tableName}
              onChange={(value) => {
                setTableName(value);
                resetSingleTableFields();
              }}
              options={tableOptions}
              searchable
              placeholder={t("database.treeChart.selectTable")}
            />
          </FormField>
          <FormField label={t("database.treeChart.labelField")}>
            <Select
              className={SELECT_CLASS}
              value={labelField}
              onChange={setLabelField}
              disabled={!selectedTable}
              options={optionsFor(selectedTable, [])}
              searchable
              placeholder={t("database.treeChart.selectLabelField")}
            />
          </FormField>
          {!isFirstPanel ? (
            <FormField label={t("database.treeChart.upstreamRelationField")}>
              <Select
                className={SELECT_CLASS}
                value={upstreamRelationField}
                onChange={setUpstreamRelationField}
                disabled={!selectedTable}
                options={optionsFor(selectedTable, [labelField])}
                searchable
                placeholder={t("database.treeChart.selectUpstreamRelationField")}
              />
            </FormField>
          ) : null}
          <FormField label={t("database.treeChart.downstreamRelationField")}>
            <Select
              className={SELECT_CLASS}
              value={downstreamRelationField}
              onChange={setDownstreamRelationField}
              disabled={!selectedTable}
              options={optionsFor(
                selectedTable,
                isFirstPanel
                  ? [labelField]
                  : [labelField, upstreamRelationField],
              )}
              searchable
              placeholder={t("database.treeChart.selectDownstreamRelationField")}
            />
          </FormField>
        </>
      )}

      <FormField
        label={t("database.treeChart.dataFilter")}
        hint={
          isJunctionMode
            ? t("database.treeChart.dataFilterDescJunction")
            : t("database.treeChart.dataFilterDesc")
        }
      >
        <div className="tree-chart-field-select__filter">
          <TreeChartPanelFilterBuilder
            columns={filterTable?.columns ?? []}
            query={filterQuery}
            onQueryChange={setFilterQuery}
            disabled={!filterTable}
          />
        </div>
      </FormField>
    </FormDialog>
  );
}
