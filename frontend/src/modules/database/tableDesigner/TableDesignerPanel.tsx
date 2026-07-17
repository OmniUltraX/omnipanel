import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../../components/ui/Button";
import { Select } from "../../../components/ui/Select";
import { TextInput, type TextInputProps } from "../../../components/ui/form/TextInput";
import { DockHandle, DockLayout, DockPanel } from "../../../components/dock";
import { useI18n } from "../../../i18n";
import { TableDdlViewer } from "../table/TableDdlViewer";
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

/** 模块级剪贴板：跨设计表 Tab 粘贴字段。 */
interface DesignerClipboardEntry {
  name: string;
  type: string;
  length: string;
  nullable: boolean;
  isPk: boolean;
  isAutoIncrement: boolean;
  defaultValue: string;
  comment: string;
}
let designerClipboard: DesignerClipboardEntry[] = [];

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
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedFieldIds, setSelectedFieldIds] = useState<Set<string>>(new Set());
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);
  const dragFieldIndexRef = useRef<number | null>(null);
  const pointerDragActiveRef = useRef(false);
  const lastSelectedIndexRef = useRef<number | null>(null);
  const gridWrapRef = useRef<HTMLDivElement | null>(null);
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
      setSelectedFieldIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
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

  // 搜索过滤（按名称 / 类型 / 注释 / 默认值匹配）
  const trimmedSearch = searchQuery.trim().toLowerCase();
  const filteredFields = useMemo(() => {
    if (!trimmedSearch) return model.fields;
    return model.fields.filter((field) => {
      const haystack = [
        field.name,
        field.type,
        field.comment,
        field.defaultValue,
      ].join(" ").toLowerCase();
      return haystack.includes(trimmedSearch);
    });
  }, [model.fields, trimmedSearch]);

  const filteredFieldIds = useMemo(
    () => new Set(filteredFields.map((f) => f.id)),
    [filteredFields],
  );

  // 选中数量（仅在当前可见行范围内统计）
  const visibleSelectedCount = useMemo(() => {
    let count = 0;
    for (const id of selectedFieldIds) {
      if (filteredFieldIds.has(id)) count++;
    }
    return count;
  }, [selectedFieldIds, filteredFieldIds]);

  const allVisibleSelected = filteredFields.length > 0 && visibleSelectedCount === filteredFields.length;

  // 多选操作
  const selectFieldRow = useCallback(
    (index: number, opts: { ctrl?: boolean; shift?: boolean; meta?: boolean } = {}) => {
      const field = model.fields[index];
      if (!field) return;
      setSelectedFieldIds((prev) => {
        const next = new Set(prev);
        if (opts.shift && lastSelectedIndexRef.current !== null) {
          const from = Math.min(lastSelectedIndexRef.current, index);
          const to = Math.max(lastSelectedIndexRef.current, index);
          for (let i = from; i <= to; i++) {
            const f = model.fields[i];
            if (f) next.add(f.id);
          }
        } else if (opts.ctrl || opts.meta) {
          if (next.has(field.id)) next.delete(field.id);
          else next.add(field.id);
        } else {
          next.clear();
          next.add(field.id);
        }
        return next;
      });
      lastSelectedIndexRef.current = index;
    },
    [model.fields],
  );

  const toggleSelectAllVisible = useCallback(() => {
    setSelectedFieldIds((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const f of filteredFields) next.delete(f.id);
        return next;
      }
      const next = new Set(prev);
      for (const f of filteredFields) next.add(f.id);
      return next;
    });
  }, [allVisibleSelected, filteredFields]);

  const clearSelection = useCallback(() => {
    setSelectedFieldIds(new Set());
    lastSelectedIndexRef.current = null;
  }, []);

  // 复制选中字段到模块级剪贴板
  const copySelectedFields = useCallback(() => {
    const selected = model.fields.filter((f) => selectedFieldIds.has(f.id));
    if (selected.length === 0) return;
    designerClipboard = selected.map((f) => ({
      name: f.name,
      type: f.type,
      length: f.length,
      nullable: f.nullable,
      isPk: f.isPk,
      isAutoIncrement: f.isAutoIncrement,
      defaultValue: f.defaultValue,
      comment: f.comment,
    }));
  }, [model.fields, selectedFieldIds]);

  // 粘贴剪贴板字段为新行（带新 ID，重置主键避免冲突）
  const pasteFields = useCallback(() => {
    if (designerClipboard.length === 0) {
      setPasteNotice(t("database.tableDesigner.pasteEmpty"));
      window.setTimeout(() => setPasteNotice(null), 2000);
      return;
    }
    const newFields = designerClipboard.map((entry) => ({
      id: `d:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`,
      name: entry.name,
      type: entry.type,
      length: entry.length,
      nullable: entry.nullable,
      isPk: false,
      isAutoIncrement: entry.isAutoIncrement,
      defaultValue: entry.defaultValue,
      comment: entry.comment,
    }));
    updateModel({ fields: [...model.fields, ...newFields] });
    const newIds = new Set(newFields.map((f) => f.id));
    setSelectedFieldIds(newIds);
    lastSelectedIndexRef.current = model.fields.length + newFields.length - 1;
  }, [model.fields, t, updateModel]);

  // 复制选中字段为新行（原地重复）
  const duplicateSelectedFields = useCallback(() => {
    const selected = model.fields.filter((f) => selectedFieldIds.has(f.id));
    if (selected.length === 0) return;
    const newFields = selected.map((f) => ({
      ...f,
      id: `d:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`,
      name: `${f.name}_copy`,
      isPk: false,
    }));
    updateModel({ fields: [...model.fields, ...newFields] });
    setSelectedFieldIds(new Set(newFields.map((f) => f.id)));
  }, [model.fields, selectedFieldIds, updateModel]);

  // 删除选中字段
  const removeSelectedFields = useCallback(() => {
    if (selectedFieldIds.size === 0) return;
    updateModel({
      fields: model.fields.filter((f) => !selectedFieldIds.has(f.id)),
    });
    clearSelection();
  }, [model.fields, selectedFieldIds, updateModel, clearSelection]);

  // 键盘快捷键
  useEffect(() => {
    if (activeTab !== "fields") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      // 在文本输入 / 文本域 / 可编辑区域中编辑时不拦截（避免影响正常打字）
      // 但 checkbox 类 input 允许快捷键（用户点选行后焦点在 checkbox 上）
      const isTextInput =
        tag === "textarea" ||
        tag === "select" ||
        target?.isContentEditable ||
        (tag === "input" && (target as HTMLInputElement).type !== "checkbox");
      if (isTextInput) {
        return;
      }
      // 仅当焦点在字段网格内 / body 时响应（Ctrl+V 例外，可在面板任意位置粘贴）
      const wrap = gridWrapRef.current;
      if (wrap && target && !wrap.contains(target) && target !== document.body) {
        if (!((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v")) return;
      }
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "c" && selectedFieldIds.size > 0) {
        event.preventDefault();
        copySelectedFields();
      } else if (mod && event.key.toLowerCase() === "v") {
        event.preventDefault();
        pasteFields();
      } else if (mod && event.key.toLowerCase() === "d" && selectedFieldIds.size > 0) {
        event.preventDefault();
        duplicateSelectedFields();
      } else if (mod && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedFieldIds(new Set(filteredFields.map((f) => f.id)));
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedFieldIds.size > 0) {
        event.preventDefault();
        removeSelectedFields();
      } else if (event.key === "Escape") {
        clearSelection();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeTab,
    selectedFieldIds,
    filteredFields,
    copySelectedFields,
    pasteFields,
    duplicateSelectedFields,
    removeSelectedFields,
    clearSelection,
  ]);

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
          <div className="db-table-designer-name-wrap">
            <span className="db-table-designer-db-prefix" title={dbName}>
              {dbName}.
            </span>
            <TextInput
              size="sm"
              className="db-table-designer-name-input"
              value={model.tableName}
              onChange={(tableName) => updateModel({ tableName })}
              placeholder={t("database.tableDesigner.tableNamePlaceholder")}
              spellCheck={false}
              autoComplete="off"
              copyable={false}
            />
          </div>
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
                  <>
                    <div className="db-table-designer-search">
                      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                        <circle cx="7" cy="7" r="4.5" />
                        <path d="M10.5 10.5 14 14" />
                      </svg>
                      <input
                        type="text"
                        className="db-table-designer-search-input"
                        placeholder={t("database.tableDesigner.searchFields")}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                    </div>
                    {selectedFieldIds.size > 0 && (
                      <span className="db-table-designer-selected-count">
                        {t("database.tableDesigner.selectedCount", { count: visibleSelectedCount })}
                      </span>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={t("database.tableDesigner.copyFields")}
                      aria-label={t("database.tableDesigner.copyFields")}
                      disabled={selectedFieldIds.size === 0}
                      onClick={copySelectedFields}
                    >
                      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                        <rect x="5" y="5" width="8" height="8" rx="1" />
                        <path d="M3 11V3h8" />
                      </svg>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={t("database.tableDesigner.pasteFields")}
                      aria-label={t("database.tableDesigner.pasteFields")}
                      onClick={pasteFields}
                    >
                      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                        <rect x="4" y="2" width="8" height="12" rx="1" />
                        <path d="M6 2v2h4V2" />
                        <path d="M6 9l2 2 2-2" />
                      </svg>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={t("database.tableDesigner.duplicateField")}
                      aria-label={t("database.tableDesigner.duplicateField")}
                      disabled={selectedFieldIds.size === 0}
                      onClick={duplicateSelectedFields}
                    >
                      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                        <rect x="2" y="2" width="9" height="9" rx="1" />
                        <path d="M5 14h9V5" />
                      </svg>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title={t("database.tableDesigner.removeSelectedFields")}
                      aria-label={t("database.tableDesigner.removeSelectedFields")}
                      disabled={selectedFieldIds.size === 0}
                      onClick={removeSelectedFields}
                    >
                      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
                        <path d="M3 5h10M6 5V3h4v2M5 5l1 9h4l1-9" />
                      </svg>
                    </Button>
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
                  </>
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
            {pasteNotice && (
              <div className="db-table-designer-paste-notice">{pasteNotice}</div>
            )}
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
                <div className="db-table-designer-grid-wrap" ref={gridWrapRef}>
                  <table className="db-table-designer-grid db-table-designer-grid--fields">
                    <thead>
                      <tr>
                        <th className="db-table-designer-cell-drag" aria-label={t("database.tableDesigner.dragHint")} />
                        <th className="db-table-designer-cell-check">
                          <input
                            type="checkbox"
                            checked={allVisibleSelected}
                            onChange={toggleSelectAllVisible}
                            aria-label={t("database.tableDesigner.copyFields")}
                          />
                        </th>
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
                      {model.fields.length === 0 ? (
                        <tr>
                          <td colSpan={11} className="db-table-designer-empty-row">
                            {t("database.tableDesigner.noFields")}
                          </td>
                        </tr>
                      ) : filteredFields.length === 0 ? (
                        <tr>
                          <td colSpan={11} className="db-table-designer-empty-row">
                            {t("database.tableDesigner.noSearchResults")}
                          </td>
                        </tr>
                      ) : (
                        filteredFields.map((field) => {
                          const index = model.fields.findIndex((f) => f.id === field.id);
                          const isSelected = selectedFieldIds.has(field.id);
                          return (
                            <tr
                              key={field.id}
                              data-field-index={index}
                              className={
                                isSelected
                                  ? "db-table-designer-row--selected"
                                  : dragFieldIndex === index
                                    ? "db-table-designer-row--dragging"
                                    : dropHoverIndex === index && dragFieldIndex !== null
                                      ? "db-table-designer-row--drop-target"
                                      : undefined
                              }
                              onClick={(event) => {
                                // 点击行选择（排除 input/button/select 等可交互元素）
                                const target = event.target as HTMLElement;
                                if (target.closest("input, button, select, textarea, .input-field")) return;
                                selectFieldRow(index, { ctrl: event.ctrlKey, shift: event.shiftKey, meta: event.metaKey });
                              }}
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
                              <td className="db-table-designer-cell-check" onClick={(event) => event.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => selectFieldRow(index, { ctrl: true })}
                                  aria-label={field.name}
                                />
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
                          );
                        })
                      )}
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
