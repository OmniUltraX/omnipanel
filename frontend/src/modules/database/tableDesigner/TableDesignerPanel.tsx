import { useCallback, useMemo, useState } from "react";
import { Button } from "../../../components/ui/Button";
import { TextInput } from "../../../components/ui/TextInput";
import { DockHandle, DockLayout, DockPanel } from "../../../components/dock";
import { useI18n } from "../../../i18n";
import { TableDdlViewer } from "../TableDdlViewer";
import type { TableDesignerDriver, TableDesignerFieldRow, TableDesignerIndexRow, TableDesignerModel } from "./types";

interface TableDesignerPanelProps {
  driver: TableDesignerDriver;
  dbName: string;
  model: TableDesignerModel;
  onModelChange: (model: TableDesignerModel) => void;
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

export function TableDesignerPanel({
  driver,
  dbName,
  model,
  onModelChange,
  onReload,
  reloading = false,
  dirty = false,
  saving = false,
  onSave,
  saveNotice,
  onDismissSaveNotice,
}: TableDesignerPanelProps) {
  const { t } = useI18n();
  const [validationKey, setValidationKey] = useState<string | null>(null);
  const typeOptions = useMemo(() => driver.getTypeOptions(), [driver]);

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

  const addIndex = useCallback(() => {
    updateModel({ indexes: [...model.indexes, driver.createEmptyIndex()] });
  }, [driver, model.indexes, updateModel]);

  const removeIndex = useCallback(
    (id: string) => {
      updateModel({ indexes: model.indexes.filter((index) => index.id !== id) });
    },
    [model.indexes, updateModel],
  );

  const previewSql = useMemo(
    () => driver.buildPreviewSql(model, dbName),
    [driver, model, dbName],
  );

  const handleValidate = useCallback(() => {
    setValidationKey(driver.validate(model));
  }, [driver, model]);

  return (
    <div className="db-table-designer">
      <div className="db-table-designer-toolbar">
        <div className="db-table-designer-toolbar-main">
          <span className="db-table-designer-engine">{driver.displayName}</span>
          <span className="db-table-designer-title">
            {dbName}.{model.tableName}
          </span>
          <TextInput
            className="db-table-designer-comment"
            value={model.comment}
            onChange={(comment) => updateModel({ comment })}
            placeholder={t("database.tableDesigner.commentPlaceholder")}
          />
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
          {onSave && (
            <Button variant="default" size="sm" disabled={!dirty || saving} onClick={onSave}>
              {saving ? t("database.tableDesigner.saving") : t("database.tableDesigner.save")}
            </Button>
          )}
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
          <DockLayout direction="horizontal" className="db-table-designer-main-split">
            <DockPanel defaultSize="62%" minSize="30%" className="db-table-designer-fields-pane">
              <div className="db-table-designer-section">
                <div className="db-table-designer-section-header">
                  <h3>{t("database.tableDesigner.fields")}</h3>
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
                </div>
                <div className="db-table-designer-grid-wrap">
                  <table className="db-table-designer-grid">
                    <thead>
                      <tr>
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
                      {model.fields.map((field) => (
                        <tr key={field.id}>
                          <td>
                            <TextInput
                              clearable={false}
                              copyable={false}
                              size="sm"
                              className=""
                              value={field.name}
                              onChange={(name) => updateField(field.id, { name })}
                            />
                          </td>
                          <td>
                            <select
                              value={field.type}
                              onChange={(event) => updateField(field.id, { type: event.target.value })}
                            >
                              {typeOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                              {!typeOptions.some((option) => option.value === field.type) && (
                                <option value={field.type}>{field.type}</option>
                              )}
                            </select>
                          </td>
                          <td>
                            <TextInput
                              clearable={false}
                              copyable={false}
                              size="sm"
                              className=""
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
                            <TextInput
                              clearable={false}
                              copyable={false}
                              size="sm"
                              className=""
                              value={field.defaultValue}
                              onChange={(defaultValue) => updateField(field.id, { defaultValue })}
                            />
                          </td>
                          <td>
                            <TextInput
                              clearable={false}
                              copyable={false}
                              size="sm"
                              className=""
                              value={field.comment}
                              onChange={(comment) => updateField(field.id, { comment })}
                            />
                          </td>
                          <td>
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
              </div>
            </DockPanel>
            <DockHandle direction="horizontal" />
            <DockPanel defaultSize="38%" minSize="24%" className="db-table-designer-indexes-pane">
              <div className="db-table-designer-section">
                <div className="db-table-designer-section-header">
                  <h3>{t("database.tableDesigner.indexes")}</h3>
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
                </div>
                <div className="db-table-designer-grid-wrap">
                  <table className="db-table-designer-grid">
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
                              <TextInput
                                clearable={false}
                                copyable={false}
                                size="sm"
                                className=""
                                value={index.name}
                                onChange={(name) => updateIndex(index.id, { name })}
                              />
                            </td>
                            <td>
                              <TextInput
                                clearable={false}
                                copyable={false}
                                size="sm"
                                className=""
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
                            <td>
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
              </div>
            </DockPanel>
          </DockLayout>
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
              <TableDdlViewer ddl={previewSql} />
            </div>
          </div>
        </DockPanel>
      </DockLayout>
    </div>
  );
}
