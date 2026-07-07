import { useEffect, useMemo, useState } from "react";
import { FormDialog, FormField } from "../../../components/ui/FormDialog";
import { Select } from "../../../components/ui/form/Select";
import { TextInput } from "../../../components/ui/TextInput";
import { useI18n } from "../../../i18n";
import type { TableSchema } from "../types";
import {
  defaultRelationDisplayField,
  type TableColumnRelation,
} from "./tableColumnRelation";

interface TableColumnRelationDialogProps {
  open: boolean;
  onClose: () => void;
  columnName: string;
  tables: TableSchema[];
  initial?: TableColumnRelation | null;
  onConfirm: (relation: TableColumnRelation | null) => void;
}

const SELECT_CLASS = "setting-select table-column-relation-dialog__select";
const INPUT_CLASS = "setting-input table-column-relation-dialog__input";

export function TableColumnRelationDialog({
  open,
  onClose,
  columnName,
  tables,
  initial,
  onConfirm,
}: TableColumnRelationDialogProps) {
  const { t } = useI18n();
  const [tableName, setTableName] = useState(initial?.tableName ?? "");
  const [fieldName, setFieldName] = useState(initial?.fieldName ?? "");
  const [displayFieldName, setDisplayFieldName] = useState(initial?.displayFieldName ?? "");
  const [alias, setAlias] = useState(initial?.alias ?? "");

  useEffect(() => {
    if (!open) return;
    setTableName(initial?.tableName ?? "");
    setFieldName(initial?.fieldName ?? "");
    setDisplayFieldName(initial?.displayFieldName ?? "");
    setAlias(initial?.alias ?? "");
  }, [open, initial?.tableName, initial?.fieldName, initial?.displayFieldName, initial?.alias]);

  const selectedTable = useMemo(
    () => tables.find((table) => table.name === tableName) ?? null,
    [tables, tableName],
  );

  const defaultDisplayField = useMemo(
    () => defaultRelationDisplayField(selectedTable),
    [selectedTable],
  );

  const tableOptions = useMemo(
    () =>
      tables.length > 0
        ? tables.map((table) => ({ value: table.name, label: table.name }))
        : [{ value: "", label: t("database.results.relationNoTables"), disabled: true }],
    [tables, t],
  );

  const fieldOptions = useMemo(() => {
    const columns = selectedTable?.columns ?? [];
    if (columns.length === 0) {
      return [{ value: "", label: t("database.results.relationNoFields"), disabled: true }];
    }
    return columns.map((column) => ({ value: column.name, label: column.name }));
  }, [selectedTable, t]);

  const displayFieldOptions = useMemo(() => {
    const columns = selectedTable?.columns ?? [];
    if (columns.length === 0) {
      return [
        {
          value: "",
          label: t("database.results.relationDisplayFieldDefault", { field: defaultDisplayField }),
        },
      ];
    }
    return [
      {
        value: "",
        label: t("database.results.relationDisplayFieldDefault", { field: defaultDisplayField }),
      },
      ...columns.map((column) => ({ value: column.name, label: column.name })),
    ];
  }, [defaultDisplayField, selectedTable, t]);

  const canConfirm = Boolean(tableName.trim() && fieldName.trim());

  const buildRelation = (): TableColumnRelation => {
    const relation: TableColumnRelation = {
      tableName: tableName.trim(),
      fieldName: fieldName.trim(),
    };
    const trimmedDisplayField = displayFieldName.trim();
    if (trimmedDisplayField) {
      relation.displayFieldName = trimmedDisplayField;
    }
    const trimmedAlias = alias.trim();
    if (trimmedAlias) {
      relation.alias = trimmedAlias;
    }
    return relation;
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={t("database.results.relationDialogTitle", { column: columnName })}
      subtitle={t("database.results.relationDialogDesc")}
      size="md"
      bodyClassName="table-column-relation-dialog"
      primaryAction={{
        label: t("common.confirm"),
        disabled: !canConfirm,
        onClick: () => {
          if (!canConfirm) return;
          onConfirm(buildRelation());
          onClose();
        },
      }}
      actions={[
        {
          key: "clear",
          label: t("database.results.relationClear"),
          variant: "ghost",
          onClick: () => {
            onConfirm(null);
            onClose();
          },
        },
      ]}
    >
      <FormField label={t("database.results.relationTable")}>
        <Select
          className={SELECT_CLASS}
          value={tableName}
          onChange={(value) => {
            setTableName(value);
            setFieldName("");
            setDisplayFieldName("");
          }}
          options={tableOptions}
          searchable
          placeholder={t("database.results.relationSelectTable")}
        />
      </FormField>
      <FormField label={t("database.results.relationField")}>
        <Select
          className={SELECT_CLASS}
          value={fieldName}
          onChange={setFieldName}
          disabled={!selectedTable}
          options={fieldOptions}
          searchable
          placeholder={t("database.results.relationSelectField")}
        />
      </FormField>
      <FormField
        label={t("database.results.relationDisplayField")}
        hint={t("database.results.relationDisplayFieldHint")}
      >
        <Select
          className={SELECT_CLASS}
          value={displayFieldName}
          onChange={setDisplayFieldName}
          disabled={!selectedTable}
          options={displayFieldOptions}
          searchable
          placeholder={t("database.results.relationSelectDisplayField")}
        />
      </FormField>
      <FormField
        label={t("database.results.relationAlias")}
        hint={t("database.results.relationAliasHint")}
      >
        <TextInput
          copyable={false}
          className={INPUT_CLASS}
          value={alias}
          onChange={setAlias}
          placeholder={t("database.results.relationAliasPlaceholder")}
        />
      </FormField>
    </FormDialog>
  );
}
