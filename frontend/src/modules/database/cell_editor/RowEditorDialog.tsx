import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CellEditDialog } from "../../../components/ui/content/CellEditDialog";
import { TextInput } from "../../../components/ui/form/TextInput";
import { useI18n } from "../../../i18n";
import type { DbColumnMeta } from "../api";
import { BooleanEditor } from "./BooleanEditor";
import { DateEditor } from "./DateEditor";
import { DateTimeEditor } from "./DateTimeEditor";
import { JsonEditor } from "./JsonEditor";
import { NullEditor } from "./NullEditor";
import { NumberEditor } from "./NumberEditor";
import { TextEditor } from "./TextEditor";
import { TimeEditor } from "./TimeEditor";
import {
  detectCellEditorKind,
  formatCellValue,
  normalizeDate,
  normalizeDatetime,
  normalizeTime,
  parseCellValue,
  shouldUseInlineCellEdit,
  type CellEditorKind,
} from "./types";

export interface RowEditorDialogProps {
  open: boolean;
  columnMeta: DbColumnMeta[];
  row: Record<string, unknown>;
  /** 未提交的单元格覆盖，用于初始化表单显示 */
  overrides?: Record<string, unknown>;
  /** 打开时聚焦并滚动到该列字段 */
  focusColumn?: string;
  /** insert：新建行；edit：编辑已有行（含主键） */
  mode?: "edit" | "insert";
  onSave: (changes: Record<string, unknown>) => void;
  onCancel: () => void;
}

function normalizeForKind(kind: CellEditorKind, rawText: string): string {
  switch (kind) {
    case "date":
      return normalizeDate(rawText);
    case "datetime":
      return normalizeDatetime(rawText);
    case "time":
      return normalizeTime(rawText);
    default:
      return rawText;
  }
}

function RowEditorField({
  column,
  value,
  onChange,
  readOnly,
  autoFocus = false,
}: {
  column: DbColumnMeta;
  value: string;
  onChange: (value: string) => void;
  readOnly: boolean;
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const fieldRef = useRef<HTMLDivElement>(null);
  const readonlyRef = useRef<HTMLInputElement>(null);
  const kind = useMemo(() => detectCellEditorKind(column.type), [column.type]);
  const isNull = value === "" && !readOnly;

  useLayoutEffect(() => {
    if (!autoFocus) return;
    fieldRef.current?.scrollIntoView({ block: "nearest" });
    if (readOnly) {
      readonlyRef.current?.focus();
      return;
    }
    const control = fieldRef.current?.querySelector<HTMLElement>(
      "input, textarea, select, button",
    );
    control?.focus();
    if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
      control.select();
    }
  }, [autoFocus, readOnly]);

  const renderEditor = () => {
    if (readOnly) {
      return (
        <TextInput
          ref={readonlyRef}
          clearable={false}
          copyable={false}
          readOnly
          className="cell-editor-input row-editor-field__input--readonly"
          value={value}
          onChange={() => undefined}
        />
      );
    }
    const props = { value, onChange, autoFocus };
    switch (kind) {
      case "number":
        return <NumberEditor {...props} />;
      case "boolean":
        return <BooleanEditor {...props} />;
      case "date":
        return <DateEditor {...props} />;
      case "datetime":
        return <DateTimeEditor {...props} />;
      case "time":
        return <TimeEditor {...props} />;
      case "json":
        return <JsonEditor {...props} />;
      case "binary":
        return <TextEditor {...props} />;
      default:
        return isNull ? <NullEditor {...props} /> : <TextEditor {...props} />;
    }
  };

  return (
    <div
      ref={fieldRef}
      className={`row-editor-field${readOnly ? " row-editor-field--readonly" : ""}${autoFocus ? " row-editor-field--focused" : ""}`}
    >
      <div className="row-editor-field__label">
        <span className="row-editor-field__name">{column.name}</span>
        <span className="row-editor-field__type">{column.type}</span>
        {column.isPk && (
          <span className="cell-editor-kind-badge row-editor-field__pk">{t("database.rowEditor.pk")}</span>
        )}
        {column.isFk && (
          <span className="cell-editor-kind-badge row-editor-field__fk">{t("database.rowEditor.fk")}</span>
        )}
      </div>
      <div className="row-editor-field__control">{renderEditor()}</div>
    </div>
  );
}

export function RowEditorDialog({
  open,
  columnMeta,
  row,
  overrides,
  focusColumn,
  mode = "edit",
  onSave,
  onCancel,
}: RowEditorDialogProps) {
  const { t } = useI18n();
  const [fieldsReady, setFieldsReady] = useState(false);

  useEffect(() => {
    if (!open) {
      setFieldsReady(false);
      return;
    }
    const frame = requestAnimationFrame(() => setFieldsReady(true));
    return () => cancelAnimationFrame(frame);
  }, [open, columnMeta, row, overrides, focusColumn, mode]);

  const formColumns = useMemo(
    () => columnMeta.filter((col) => !shouldUseInlineCellEdit(col.type)),
    [columnMeta],
  );
  const focusColName = useMemo(() => {
    if (!focusColumn) return null;
    if (formColumns.some((col) => col.name === focusColumn)) return focusColumn;
    return formColumns[0]?.name ?? null;
  }, [focusColumn, formColumns]);

  const initialTexts = useMemo(() => {
    const texts: Record<string, string> = {};
    for (const col of formColumns) {
      const raw = overrides?.[col.name] !== undefined ? overrides[col.name] : row[col.name];
      const kind = detectCellEditorKind(col.type);
      const formatted = formatCellValue(raw);
      texts[col.name] = normalizeForKind(kind, formatted);
    }
    return texts;
  }, [formColumns, overrides, row]);

  const [editTexts, setEditTexts] = useState(initialTexts);

  useEffect(() => {
    if (open) {
      setEditTexts(initialTexts);
    }
  }, [open, initialTexts]);

  const handleSave = useCallback(() => {
    const changes: Record<string, unknown> = {};
    for (const col of formColumns) {
      const kind = detectCellEditorKind(col.type);
      const parsed = parseCellValue(kind, editTexts[col.name] ?? "");
      changes[col.name] = parsed;
    }
    onSave(changes);
  }, [formColumns, editTexts, onSave]);

  const updateField = useCallback((name: string, value: string) => {
    setEditTexts((prev) => ({ ...prev, [name]: value }));
  }, []);

  return (
    <CellEditDialog
      open={open}
      title={mode === "insert" ? t("database.rowEditor.newTitle") : t("database.rowEditor.title")}
      className="row-editor-dialog"
      onConfirm={handleSave}
      onCancel={onCancel}
      confirmLabel={mode === "insert" ? t("database.rowEditor.newSave") : t("database.rowEditor.save")}
    >
      <div className="row-editor-fields">
        {fieldsReady ? (
          formColumns.length > 0 ? (
            formColumns.map((col) => (
              <RowEditorField
                key={col.name}
                column={col}
                value={editTexts[col.name] ?? ""}
                onChange={(value) => updateField(col.name, value)}
                readOnly={false}
                autoFocus={Boolean(focusColName && col.name === focusColName)}
              />
            ))
          ) : (
            <div className="empty-state compact row-editor-inline-hint">
              {t("database.rowEditor.inlineFieldsHint")}
            </div>
          )
        ) : (
          <div className="empty-state compact" style={{ padding: "var(--sp-4)" }}>
            {t("common.loading")}
          </div>
        )}
      </div>
    </CellEditDialog>
  );
}
