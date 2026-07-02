import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../../components/ui/Button";
import { Select } from "../../../components/ui/Select";
import { TextInput, type TextInputProps } from "../../../components/ui/TextInput";
import { DockHandle, DockLayout, DockPanel } from "../../../components/dock";
import { useI18n } from "../../../i18n";
import { TableDdlViewer } from "../TableDdlViewer";
import type { TableDesignerDriver, TableDesignerFieldRow, TableDesignerIndexRow, TableDesignerModel, TableDesignerTypeOption } from "./types";

interface TableDesignerPanelProps {
  driver: TableDesignerDriver;
  dbName: string;
  baseline: TableDesignerModel;
  model: TableDesignerModel;  onModelChange: (model: TableDesignerModel) => void;
  onReload?: () => void;
  reloading?: boolean;
  dirty?: boolean;
  saving?: boolean;
  onSave?: () => void;
  saveNotice?: { kind: "success" | "error"; message: string } | null;
  onDismissSaveNotice?: () => void;
}

function parseIndexColumns(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveFieldRowIndexFromMouseEvent(event: MouseEvent): number | null {
  const el = document.elementFromPoint(event.clientX, event.clientY);
  const row = el?.closest("tr[data-field-index]");
  if (!row) {
    return null;
  }
  const index = Number((row as HTMLElement).dataset.fieldIndex);
  return Number.isNaN(index) ? null : index;
}

function formatApplySqlPreview(statements: string[]): string {
  if (statements.length === 0) {
    return "";
  }
  return statements
    .map((statement) => (statement.trimEnd().endsWith(";") ? statement.trimEnd() : `${statement.trimEnd()};`))
    .join("\n\n");
}

function resolveFieldTypeOptions(
  typeOptions: readonly TableDesignerTypeOption[],
  currentType: string,
): TableDesignerTypeOption[] {
  if (!currentType || typeOptions.some((option) => option.value === currentType)) {
    return [...typeOptions];
  }
  return [...typeOptions, { value: currentType, label: currentType }];
}

const TABLE_DESIGNER_SELECT_Z_INDEX = 10100;

type DesignerCellTextInputProps = Omit<TextInputProps, "size" | "className"> & {
  className?: string;
};

/** 表设计网格单元格内文本输入，使用全局 TextInput（含复制 / 清空） */
function DesignerCellTextInput({ className, ...props }: DesignerCellTextInputProps) {
  return (
    <TextInput
      {...props}
      size="sm"
      className={["input", "db-table-designer-cell-input", className].filter(Boolean).join(" ")}
    />
  );
}

type DesignerTabId = "fields" | "indexes";

export function TableDesignerPanel({
  driver,
  dbName,
  baseline,
  model,  onModelChange,
  onReload,
  reloading = false,
  dirty = false,
  saving = false,
  onSave,
  saveNotice,
  onDismissSaveNotice,
}: TableDesignerPanelProps) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<DesignerTabId>("fields");
  const [validationKey, setValidationKey] = useState<string | null>(null);
  const [dragFieldIndex, setDragFieldIndex] = useState<number | null>(null);
  const [dropHoverIndex, setDropHoverIndex] = useState<number | null>(null);
  const dragFieldIndexRef = useRef<number | null>(null);
  const pointerDragActiveRef = useRef(false);
  const typeOptions = useMemo(() => driver.getTypeOptions(), [driver]);

  const setDragSourceIndex = useCallback((index: number | null) => {
    dragFieldIndexRef.current = index;
    setDragFieldIndex(index);
  }, []);

  const clearDragSourceIndex = useCallback(() => {
    dragFieldIndexRef.current = null;
    setDragFieldIndex(null);
  }, []);

  const updateModel = useCallback(
    (patch: Partial<TableDesignerModel>) => {
      onModelChange({ ...model, ...patch });
      setValidationKey(null);
    },
    [model, onModelChange],
  );
  const updateField = useCallback(
    (id: string, patch: Partial<TableDesignerFieldRow>) => {
      updateModel({
        fields: model.fields.map((field) => (field.id === id ? { ...field, ...patch } : field)),
      });
    },
    [model.fields, updateModel],
  );

  const updateIndex = useCallback(
    (id: string, patch: Partial<TableDesignerIndexRow>) => {
      updateModel({
        indexes: model.indexes.map((index) => (index.id === id ? { ...index, ...patch } : index)),
      });
    },
    [model.indexes, updateModel],
  );

  const addField = useCallback(() => {
    updateModel({ fields: [...model.fields, driver.createEmptyField()] });
  }, [driver, model.fields, updateModel]);

  const removeField = useCallback(
    (id: string) => {
      updateModel({ fields: model.fields.filter((field) => field.id !== id) });
    },
    [model.fields, updateModel],
  );

  const reorderFields = useCallback(
    (from: number, to: number) => {
      if (from === to || from < 0 || to < 0 || from >= model.fields.length || to >= model.fields.length) {
        return;
      }
      const next = [...model.fields];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      updateModel({ fields: next });
    },
    [model.fields, updateModel],
  );

  const beginFieldPointerDrag = useCallback(
    (index: number) => {
      pointerDragActiveRef.current = true;
      setDragSourceIndex(index);
      setDropHoverIndex(index);
    },
    [setDragSourceIndex],
  );
  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      if (!pointerDragActiveRef.current) {
        return;
      }
      const hoverIndex = resolveFieldRowIndexFromMouseEvent(event);
      setDropHoverIndex((prev) => (prev === hoverIndex ? prev : hoverIndex));
    };

    const onMouseUp = (event: MouseEvent) => {
      if (!pointerDragActiveRef.current) {
        return;
      }
      pointerDragActiveRef.current = false;
      const from = dragFieldIndexRef.current;
      const to = resolveFieldRowIndexFromMouseEvent(event);
      setDropHoverIndex(null);
      if (from !== null && to !== null) {
        reorderFields(from, to);
      }
      clearDragSourceIndex();    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [clearDragSourceIndex, reorderFields]);

  const addIndex = useCallback(() => {
    updateModel({ indexes: [...model.indexes, driver.createEmptyIndex()] });
  }, [driver, model.indexes, updateModel]);

  const removeIndex = useCallback(
    (id: string) => {
      updateModel({ indexes: model.indexes.filter((index) => index.id !== id) });
    },
    [model.indexes, updateModel],
  );

  const applyStatements = useMemo(
    () => driver.buildApplySql(baseline, model, dbName),
    [driver, baseline, model, dbName],
  );

  const applySqlPreview = useMemo(() => {
    const sql = formatApplySqlPreview(applyStatements);
    if (sql) {
      return sql;
    }
    return `-- ${t("database.tableDesigner.applySqlEmpty")}`;
  }, [applyStatements, t]);

  const handleValidate = useCallback(() => {    setValidationKey(driver.validate(model));
  }, [driver, model]);

  return (
    <div className="db-table-designer">
      <div className="db-table-designer-toolbar">
        <div className="db-table-designer-toolbar-main">
          <span className="db-table-designer-engine">{driver.displayName}</span>
          <span className="db-table-designer-title">
            {dbName}.{model.tableName}
          </span>
          <div className="db-table-designer-comment-wrap">
            <TextInput
              size="sm"
              className="input"
              value={model.comment}
              onChange={(comment) => updateModel({ comment })}
              placeholder={t("database.tableDesigner.commentPlaceholder")}
            />
          </div>
        </div>
        <div className="db-table-designer-toolbar-actions">
          {onReload && (
            <Button variant="ghost" size="sm" disabled={reloading || saving} onClick={onReload}>
              {t("common.refresh")}
            </Button>
          )}
          <Button variant="secondary" size="sm" disabled={saving} onClick={handleValidate}>
            {t("database.tableDesigner.validate")}
          </Button>
        </div>
      </div>
      {saveNotice && (
        <div
          className={
            saveNotice.kind === "success"
              ? "db-table-designer-notice db-table-designer-notice--success"
              : "db-table-designer-notice db-table-designer-notice--error"
          }
          role="status"
        >
          <span>{saveNotice.message}</span>
          {onDismissSaveNotice && (
            <button
              type="button"
              className="db-table-designer-notice-dismiss"
              aria-label={t("common.cancel")}
              onClick={onDismissSaveNotice}
            >
              ×
            </button>
          )}
        </div>
      )}

      {validationKey && (
        <div className="db-table-designer-validation">
          {t(`database.tableDesigner.validation.${validationKey}` as never)}
        </div>
      )}

      <DockLayout direction="vertical" className="db-table-designer-split">
        <DockPanel defaultSize="68%" minSize="35%" className="db-table-designer-main-pane">
          <div className="db-table-designer-section">
            <div className="db-table-designer-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                className={`db-toolbox-tab${activeTab === "fields" ? " active" : ""}`}
                aria-selected={activeTab === "fields"}
                onClick={() => setActiveTab("fields")}
              >
                {t("database.tableDesigner.fields")}
              </button>
              <button
                type="button"
                role="tab"
                className={`db-toolbox-tab${activeTab === "indexes" ? " active" : ""}`}
                aria-selected={activeTab === "indexes"}
                onClick={() => setActiveTab("indexes")}
              >
                {t("database.tableDesigner.indexes")}
              </button>
              <div className="db-table-designer-tabs-actions">
                {activeTab === "fields" ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title={t("database.tableDesigner.addField")}
                    aria-label={t("database.tableDesigner.addField")}
                    onClick={addField}
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                      <path d="M8 3v10M3 8h10" />
                    </svg>
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title={t("database.tableDesigner.addIndex")}
                    aria-label={t("database.tableDesigner.addIndex")}
                    onClick={addIndex}
                  >
                    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                      <path d="M8 3v10M3 8h10" />
                    </svg>
                  </Button>
                )}
              </div>
            </div>
            <div
              className="db-table-designer-tab-panel"
              role="tabpanel"
              aria-label={
                activeTab === "fields"
                  ? t("database.tableDesigner.fields")
                  : t("database.tableDesigner.indexes")
              }
            >
              {activeTab === "fields" ? (
                <div className="db-table-designer-grid-wrap">
                  <table className="db-table-designer-grid db-table-designer-grid--fields">
                    <thead>
                      <tr>
                        <th className="db-table-designer-cell-drag" aria-label={t("database.tableDesigner.dragHint")} />
                        <th>{t("database.tableDesigner.field.name")}</th>
                        <th>{t("database.tableDesigner.field.type")}</th>
                        <th>{t("database.tableDesigner.field.length")}</th>
                        <th>{t("database.tableDesigner.field.nullable")}</th>
                        <th>{t("database.tableDesigner.field.pk")}</th>
                        <th>{t("database.tableDesigner.field.autoIncrement")}</th>
                        <th>{t("database.tableDesigner.field.default")}</th>
                        <th>{t("database.tableDesigner.field.comment")}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {model.fields.map((field, index) => (
                        <tr
                          key={field.id}
                          data-field-index={index}
                          className={
                            dragFieldIndex === index
                              ? "db-table-designer-row--dragging"
                              : dropHoverIndex === index && dragFieldIndex !== null
                                ? "db-table-designer-row--drop-target"
                                : undefined
                          }
                        >
                          <td className="db-table-designer-cell-drag">
                            <button
                              type="button"
                              className="db-table-designer-drag"
                              title={t("database.tableDesigner.dragHint")}
                              onMouseDown={(event) => {
                                if (event.button !== 0) {
                                  return;
                                }
                                event.preventDefault();
                                event.stopPropagation();
                                beginFieldPointerDrag(index);
                              }}
                            >
                              <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12" aria-hidden>
                                <circle cx="9" cy="6" r="1.2" />
                                <circle cx="15" cy="6" r="1.2" />
                                <circle cx="9" cy="12" r="1.2" />
                                <circle cx="15" cy="12" r="1.2" />
                                <circle cx="9" cy="18" r="1.2" />
                                <circle cx="15" cy="18" r="1.2" />
                              </svg>
                            </button>
                          </td>
                          <td>
                            <DesignerCellTextInput
                              value={field.name}
                              onChange={(name) => updateField(field.id, { name })}
                            />
                          </td>
                          <td>
                            <Select
                              value={field.type}
                              onChange={(type) => updateField(field.id, { type })}
                              options={resolveFieldTypeOptions(typeOptions, field.type)}
                              size="sm"
                              searchable
                              className="db-table-designer-cell-select"
                              aria-label={t("database.tableDesigner.field.type")}
                              panelZIndex={TABLE_DESIGNER_SELECT_Z_INDEX}
                            />
                          </td>
                          <td>
                            <DesignerCellTextInput
                              value={field.length}
                              onChange={(length) => updateField(field.id, { length })}
                            />
                          </td>
                          <td className="db-table-designer-cell-center">
                            <input
                              type="checkbox"
                              checked={field.nullable}
                              onChange={(event) => updateField(field.id, { nullable: event.target.checked })}
                            />
                          </td>
                          <td className="db-table-designer-cell-center">
                            <input
                              type="checkbox"
                              checked={field.isPk}
                              onChange={(event) => updateField(field.id, { isPk: event.target.checked })}
                            />
                          </td>
                          <td className="db-table-designer-cell-center">
                            <input
                              type="checkbox"
                              checked={field.isAutoIncrement}
                              onChange={(event) =>
                                updateField(field.id, { isAutoIncrement: event.target.checked })
                              }
                            />
                          </td>
                          <td>
                            <DesignerCellTextInput
                              value={field.defaultValue}
                              onChange={(defaultValue) => updateField(field.id, { defaultValue })}
                            />
                          </td>
                          <td>
                            <DesignerCellTextInput
                              value={field.comment}
                              onChange={(comment) => updateField(field.id, { comment })}
                            />
                          </td>
                          <td className="db-table-designer-cell-actions">
                            <button
                              type="button"
                              className="btn-icon db-table-designer-remove"
                              title={t("database.tableDesigner.removeField")}
                              aria-label={t("database.tableDesigner.removeField")}
                              onClick={() => removeField(field.id)}
                            >
                              ×
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="db-table-designer-grid-wrap">
                  <table className="db-table-designer-grid db-table-designer-grid--indexes">
                    <thead>
                      <tr>
                        <th>{t("database.tableDesigner.index.name")}</th>
                        <th>{t("database.tableDesigner.index.columns")}</th>
                        <th>{t("database.tableDesigner.index.unique")}</th>
                        <th>{t("database.tableDesigner.index.primary")}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {model.indexes.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="db-table-designer-empty-row">
                            {t("database.tableDesigner.noIndexes")}
                          </td>
                        </tr>
                      ) : (
                        model.indexes.map((index) => (
                          <tr key={index.id}>
                            <td>
                              <DesignerCellTextInput
                                value={index.name}
                                onChange={(name) => updateIndex(index.id, { name })}
                              />
                            </td>
                            <td>
                              <DesignerCellTextInput
                                value={index.columns.join(", ")}
                                placeholder={t("database.tableDesigner.index.columnsPlaceholder")}
                                onChange={(value) =>
                                  updateIndex(index.id, { columns: parseIndexColumns(value) })
                                }
                              />
                            </td>
                            <td className="db-table-designer-cell-center">
                              <input
                                type="checkbox"
                                checked={index.unique}
                                onChange={(event) => updateIndex(index.id, { unique: event.target.checked })}
                              />
                            </td>
                            <td className="db-table-designer-cell-center">
                              <input
                                type="checkbox"
                                checked={index.primary}
                                onChange={(event) => updateIndex(index.id, { primary: event.target.checked })}
                              />
                            </td>
                            <td className="db-table-designer-cell-actions">
                              <button
                                type="button"
                                className="btn-icon db-table-designer-remove"
                                title={t("database.tableDesigner.removeIndex")}
                                aria-label={t("database.tableDesigner.removeIndex")}
                                onClick={() => removeIndex(index.id)}
                              >
                                ×
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </DockPanel>
        <DockHandle direction="vertical" />
        <DockPanel defaultSize="32%" minSize="18%" className="db-table-designer-sql-pane">
          <div className="db-table-designer-section db-table-designer-section--sql">
            <div className="db-table-designer-section-header">
              <h3>{t("database.tableDesigner.previewSql")}</h3>
              <span className="db-table-designer-preview-hint">
                {t("database.tableDesigner.previewHint")}
              </span>
            </div>
            <div className="db-table-designer-sql-content">
              <TableDdlViewer ddl={applySqlPreview} />
            </div>
            {onSave && (
              <div className="db-table-designer-sql-footer">
                <Button variant="default" size="sm" disabled={!dirty || saving} onClick={onSave}>
                  {saving ? t("database.tableDesigner.saving") : t("database.tableDesigner.save")}
                </Button>
              </div>
            )}
          </div>        </DockPanel>
      </DockLayout>
    </div>
  );
}
