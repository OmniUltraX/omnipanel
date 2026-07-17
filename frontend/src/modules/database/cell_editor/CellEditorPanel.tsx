import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ContentPreviewView,
  ContentPreviewTextModeToolbar,
  useContentPreviewTextModes,
  type ContentPreviewTextMode,
} from "../../../components/ui/content/ContentPreviewView";
import { resolvePreferredPreviewTextMode } from "../../../lib/contentPreview";
import { useI18n } from "../../../i18n";
import { showToast } from "../../../stores/toastStore";
import type { DbColumnMeta } from "../api";
import {
  resolveCellPreviewCodeLanguage,
  resolveCellPreviewContent,
} from "../grid/tableCellPreview";
import { BooleanEditor } from "./BooleanEditor";
import { DateEditor } from "./DateEditor";
import { DateTimeEditor } from "./DateTimeEditor";
import { NullEditor } from "./NullEditor";
import { NumberEditor } from "./NumberEditor";
import { TimeEditor } from "./TimeEditor";
import {
  detectCellEditorKind,
  formatCellValue,
  isSameCellValue,
  normalizeDate,
  normalizeDatetime,
  normalizeTime,
  parseCellValue,
  type CellEditorKind,
} from "./types";

export type CellEditorPanelHandle = {
  commitIfDirty: () => void;
  focusEditor: () => void;
};

export interface CellEditorPanelProps {
  columnName: string | null;
  columnType: string;
  currentValue: unknown;
  /** 用于切换单元格时重置编辑器 */
  cellKey: string | null;
  /** 多选时的单元格数量（>1 时显示批量编辑提示） */
  selectionCount?: number;
  /** 底栏编辑器是否展开（多选批量赋值仅在展开时生效） */
  editorOpen?: boolean;
  /** 只读预览（如 Redis）：走结构化渲染，不落库编辑 */
  readOnly?: boolean;
  /** 网格行号（0-based）；展示时 +1 */
  rowIndex?: number | null;
  /** 列元数据（可空、长度、注释等） */
  columnMeta?: DbColumnMeta | null;
  /** 用于生成 SQL 条件引号风格 */
  dbType?: string;
  onApply: (payload: { rawText: string; parsed: unknown }) => void;
  onSetNull?: () => void;
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

function usesRichContentPreview(kind: CellEditorKind): boolean {
  return kind === "text" || kind === "json" || kind === "binary";
}

function quoteIdent(dbType: string | undefined, name: string): string {
  const t = (dbType ?? "mysql").toLowerCase();
  if (t.includes("postgres") || t.includes("pg")) {
    return `"${name.replace(/"/g, '""')}"`;
  }
  if (t.includes("sqlserver") || t.includes("mssql")) {
    return `[${name.replace(/]/g, "]]")}]`;
  }
  return `\`${name.replace(/`/g, "``")}\``;
}

function buildSqlCondition(
  columnName: string,
  value: unknown,
  editText: string,
  dbType: string | undefined,
): string {
  const col = quoteIdent(dbType, columnName);
  if (value === null || value === undefined) {
    return `${col} IS NULL`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return `${col} = ${value}`;
  }
  if (typeof value === "boolean") {
    return `${col} = ${value ? "TRUE" : "FALSE"}`;
  }
  const text = (editText || formatCellValue(value)).replace(/'/g, "''");
  return `${col} = '${text}'`;
}

export const CellEditorPanel = forwardRef<CellEditorPanelHandle, CellEditorPanelProps>(
  function CellEditorPanel(
    {
      columnName,
      columnType,
      currentValue,
      cellKey,
      selectionCount = 0,
      editorOpen = true,
      readOnly = false,
      rowIndex = null,
      columnMeta = null,
      dbType,
      onApply,
      onSetNull,
    },
    ref,
  ) {
    const { t } = useI18n();
    const bodyRef = useRef<HTMLDivElement>(null);
    const editTextRef = useRef("");
    const baselineTextRef = useRef("");
    const cellKeyRef = useRef(cellKey);
    const resolvedType = columnMeta?.type?.trim() || columnType;
    const editorKind = useMemo(() => detectCellEditorKind(resolvedType), [resolvedType]);
    const richPreview = usesRichContentPreview(editorKind);
    const rawText = useMemo(() => formatCellValue(currentValue), [currentValue]);
    const normalized = useMemo(
      () => normalizeForKind(editorKind, rawText),
      [editorKind, rawText],
    );
    const [editText, setEditText] = useState(normalized);
    const [textMode, setTextMode] = useState<ContentPreviewTextMode>("plain");
    editTextRef.current = editText;
    const isNull = currentValue === null || currentValue === undefined;

    const previewContent = useMemo(() => {
      if (!richPreview) {
        return null;
      }
      if (isNull && editText === "") {
        return { kind: "text" as const, text: "NULL" };
      }
      return resolveCellPreviewContent(editText, resolvedType, { sniffContent: true });
    }, [richPreview, isNull, editText, resolvedType]);

    const isMediaPreview =
      previewContent?.kind === "image" || previewContent?.kind === "audio";

    const codeLanguage = useMemo(
      () =>
        previewContent
          ? resolveCellPreviewCodeLanguage(resolvedType, previewContent)
          : undefined,
      [resolvedType, previewContent],
    );

    const sourceTextForModes =
      previewContent?.kind === "text"
        ? previewContent.text
        : previewContent?.kind === "json"
          ? JSON.stringify(previewContent.value, null, 2)
          : undefined;

    const modeOptions = useContentPreviewTextModes(
      sourceTextForModes,
      codeLanguage,
      previewContent?.kind,
    );

    useEffect(() => {
      if (!previewContent || isMediaPreview) {
        return;
      }
      setTextMode(resolvePreferredPreviewTextMode(previewContent));
    }, [cellKey, previewContent, isMediaPreview]);

    useEffect(() => {
      if (cellKeyRef.current === cellKey) return;
      cellKeyRef.current = cellKey;
      baselineTextRef.current = normalized;
      setEditText(normalized);
    }, [cellKey, normalized]);

    const applyValue = useCallback(
      (value: string) => {
        if (!columnName && selectionCount <= 0) return;
        if (selectionCount > 1 && !editorOpen) return;
        const parsed = parseCellValue(editorKind, value);
        if (selectionCount <= 1 && isSameCellValue(currentValue, parsed)) return;
        onApply({ rawText: value, parsed });
        baselineTextRef.current = value;
      },
      [columnName, currentValue, editorKind, editorOpen, onApply, selectionCount],
    );

    const focusEditor = useCallback(() => {
      const control = bodyRef.current?.querySelector<HTMLElement>(
        "input, textarea, select, button, .cm-content, [contenteditable='true']",
      );
      control?.focus();
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        commitIfDirty: () => {
          if (editTextRef.current === baselineTextRef.current) return;
          applyValue(editTextRef.current);
        },
        focusEditor,
      }),
      [applyValue, focusEditor],
    );

    const handleChange = useCallback((value: string) => {
      setEditText(value);
    }, []);

    const copyText = useCallback(async (text: string, okMessage: string) => {
      try {
        await navigator.clipboard.writeText(text);
        showToast(okMessage);
      } catch {
        showToast(t("database.cellEditor.copyFailed"));
      }
    }, [t]);

    const handleCopyValue = useCallback(() => {
      void copyText(editText, t("database.cellEditor.copyValueDone"));
    }, [copyText, editText, t]);

    const handleCopyColumnName = useCallback(() => {
      if (!columnName) return;
      void copyText(columnName, t("database.cellEditor.copyColumnNameDone"));
    }, [columnName, copyText, t]);

    const handleCopySqlCondition = useCallback(() => {
      if (!columnName) return;
      const sql = buildSqlCondition(columnName, currentValue, editText, dbType);
      void copyText(sql, t("database.cellEditor.copySqlConditionDone"));
    }, [columnName, currentValue, editText, dbType, copyText, t]);

    const handleSetNull = useCallback(() => {
      if (!onSetNull || readOnly) return;
      onSetNull();
      setEditText("");
      baselineTextRef.current = "";
    }, [onSetNull, readOnly]);

    const renderEditor = () => {
      if (richPreview && isNull && editText === "") {
        return <NullEditor value={editText} onChange={handleChange} autoFocus={false} />;
      }

      if (richPreview && previewContent) {
        return (
          <div className="db-cell-editor-blob-preview">
            {!isMediaPreview ? (
              <div className="db-cell-editor-blob-preview-toolbar">
                <ContentPreviewTextModeToolbar
                  mode={textMode}
                  onModeChange={setTextMode}
                  showCodeMode={modeOptions.showCodeMode}
                  showJsonMode={modeOptions.showJsonMode}
                  showMarkdownMode={modeOptions.showMarkdownMode}
                  showWebMode={modeOptions.showWebMode}
                />
              </div>
            ) : null}
            <ContentPreviewView
              status="ready"
              content={previewContent}
              textMode={textMode}
              onTextModeChange={setTextMode}
              codeLanguage={codeLanguage ?? (previewContent.kind === "json" ? "json" : "text")}
              showTextModeToolbar={false}
              className="db-cell-editor-blob-preview-view"
              contentResetKey={cellKey ?? "cell"}
              editable={!readOnly && !isMediaPreview}
              onTextChange={readOnly ? undefined : handleChange}
            />
          </div>
        );
      }

      const props = { value: editText, onChange: handleChange, autoFocus: false };
      let compactEditor = null;
      switch (editorKind) {
        case "number":
          compactEditor = <NumberEditor {...props} />;
          break;
        case "boolean":
          compactEditor = <BooleanEditor {...props} />;
          break;
        case "date":
          compactEditor = <DateEditor {...props} />;
          break;
        case "datetime":
          compactEditor = <DateTimeEditor {...props} />;
          break;
        case "time":
          compactEditor = <TimeEditor {...props} />;
          break;
        default:
          compactEditor = isNull ? <NullEditor {...props} /> : null;
      }
      if (!compactEditor) return null;
      // 日期/数值等短控件勿撑满值区（否则垂直居中 + 原生日历锚点错乱）
      if (
        editorKind === "date" ||
        editorKind === "datetime" ||
        editorKind === "time" ||
        editorKind === "number" ||
        editorKind === "boolean"
      ) {
        return <div className="db-cell-editor-compact">{compactEditor}</div>;
      }
      return compactEditor;
    };

    if ((!columnName || !cellKey) && selectionCount <= 0) {
      return (
        <div className="db-cell-editor-panel db-cell-editor-panel--empty">
          <div className="empty-state compact">{t("database.cellEditor.selectCellHint")}</div>
        </div>
      );
    }

    const isMultiSelection = selectionCount > 1;
    const displayRow = rowIndex != null && rowIndex >= 0 ? rowIndex + 1 : null;
    const nullableLabel =
      columnMeta?.nullable === undefined
        ? "—"
        : columnMeta.nullable
          ? "true"
          : "false";
    const lengthLabel =
      columnMeta?.length != null && columnMeta.length > 0
        ? String(columnMeta.length)
        : String(editText.length);
    const comment = columnMeta?.comment?.trim() || "";
    const canSetNull = Boolean(onSetNull) && !readOnly && !isNull;

    return (
      <div ref={bodyRef} className="db-cell-editor-panel">
        {isMultiSelection ? (
          <div className="db-cell-editor-multi-hint empty-state compact">
            {t("database.cellEditor.multiCellHint", { count: selectionCount })}
          </div>
        ) : (
          <div className="db-cell-editor-meta">
            <div className="db-cell-editor-meta-block">
              <div className="db-cell-editor-meta-label">{t("database.cellEditor.columnName")}</div>
              <div className="db-cell-editor-meta-value db-cell-editor-meta-value--strong">
                {columnName ?? "—"}
              </div>
            </div>
            <div className="db-cell-editor-meta-grid">
              <div className="db-cell-editor-meta-cell">
                <span className="db-cell-editor-meta-label">{t("database.cellEditor.rowNumber")}</span>
                <span className="db-cell-editor-meta-value">{displayRow ?? "—"}</span>
              </div>
              <div className="db-cell-editor-meta-cell">
                <span className="db-cell-editor-meta-label">{t("database.cellEditor.dataType")}</span>
                <span className="db-cell-editor-meta-value db-cell-editor-meta-value--type">
                  {resolvedType || "—"}
                </span>
              </div>
              <div className="db-cell-editor-meta-cell">
                <span className="db-cell-editor-meta-label">NULL</span>
                <span className="db-cell-editor-meta-value">{nullableLabel}</span>
              </div>
              <div className="db-cell-editor-meta-cell">
                <span className="db-cell-editor-meta-label">{t("database.cellEditor.length")}</span>
                <span className="db-cell-editor-meta-value">{lengthLabel}</span>
              </div>
            </div>
            <div className="db-cell-editor-meta-block">
              <div className="db-cell-editor-meta-label">{t("database.cellEditor.comment")}</div>
              <div className="db-cell-editor-meta-value">
                {comment || t("database.cellEditor.noComment")}
              </div>
            </div>
          </div>
        )}

        <div className="db-cell-editor-value-section">
          <div className="db-cell-editor-value-header">
            <span className="db-cell-editor-value-title">{t("database.tableDetail.valueTab")}</span>
            <div className="db-cell-editor-value-tools">
              {!readOnly ? (
                <button
                  type="button"
                  className="db-cell-editor-icon-btn"
                  title={t("database.cellEditor.focusEditor")}
                  aria-label={t("database.cellEditor.focusEditor")}
                  onClick={focusEditor}
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                    <path d="M3 12.5 11.5 4l1.5 1.5L4.5 14H3v-1.5z" strokeLinejoin="round" />
                    <path d="M10.5 4.5 12 3l1.5 1.5-1.5 1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              ) : null}
              <button
                type="button"
                className="db-cell-editor-icon-btn"
                title={t("database.cellEditor.copyValue")}
                aria-label={t("database.cellEditor.copyValue")}
                onClick={handleCopyValue}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                  <rect x="5.5" y="5.5" width="7" height="7" rx="1" />
                  <path d="M3.5 10.5V3.5h7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
          <div className="db-cell-editor-value-body">{renderEditor()}</div>
        </div>

        <div className="db-cell-editor-footer-actions">
          {canSetNull ? (
            <button type="button" className="db-cell-editor-action-btn" onClick={handleSetNull}>
              <span className="db-cell-editor-action-icon" aria-hidden>×</span>
              {t("database.cellEditor.setNull")}
            </button>
          ) : null}
          {columnName ? (
            <button type="button" className="db-cell-editor-action-btn" onClick={handleCopyColumnName}>
              <span className="db-cell-editor-action-icon" aria-hidden>
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="5.5" y="5.5" width="7" height="7" rx="1" />
                  <path d="M3.5 10.5V3.5h7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              {t("database.cellEditor.copyColumnName")}
            </button>
          ) : null}
          {columnName ? (
            <button type="button" className="db-cell-editor-action-btn" onClick={handleCopySqlCondition}>
              <span className="db-cell-editor-action-icon" aria-hidden>
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M5 4.5 2.5 8 5 11.5M11 4.5 13.5 8 11 11.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              {t("database.cellEditor.copySqlCondition")}
            </button>
          ) : null}
        </div>
      </div>
    );
  },
);
