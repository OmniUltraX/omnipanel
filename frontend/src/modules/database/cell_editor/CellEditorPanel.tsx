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
      onApply,
    },
    ref,
  ) {
    const { t } = useI18n();
    const bodyRef = useRef<HTMLDivElement>(null);
    const editTextRef = useRef("");
    const baselineTextRef = useRef("");
    const cellKeyRef = useRef(cellKey);
    const editorKind = useMemo(() => detectCellEditorKind(columnType), [columnType]);
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
      // 编辑中以当前文本为准，便于实时切换 JSON / Markdown / 图片识别
      return resolveCellPreviewContent(editText, columnType, { sniffContent: true });
    }, [richPreview, isNull, editText, columnType]);

    const isMediaPreview =
      previewContent?.kind === "image" || previewContent?.kind === "audio";

    const codeLanguage = useMemo(
      () =>
        previewContent
          ? resolveCellPreviewCodeLanguage(columnType, previewContent)
          : undefined,
      [columnType, previewContent],
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

    useImperativeHandle(
      ref,
      () => ({
        commitIfDirty: () => {
          if (editTextRef.current === baselineTextRef.current) return;
          applyValue(editTextRef.current);
        },
        focusEditor: () => {
          const control = bodyRef.current?.querySelector<HTMLElement>(
            "input, textarea, select, button, .cm-content, [contenteditable='true']",
          );
          control?.focus();
        },
      }),
      [applyValue],
    );

    const handleChange = useCallback((value: string) => {
      setEditText(value);
    }, []);

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
      switch (editorKind) {
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
        default:
          return isNull ? <NullEditor {...props} /> : null;
      }
    };

    if ((!columnName || !cellKey) && selectionCount <= 0) {
      return (
        <div className="db-cell-editor-panel db-cell-editor-panel--empty">
          <div className="empty-state compact">{t("database.cellEditor.selectCellHint")}</div>
        </div>
      );
    }

    const isMultiSelection = selectionCount > 1;

    return (
      <div ref={bodyRef} className="db-cell-editor-panel">
        {isMultiSelection ? (
          <div className="db-cell-editor-multi-hint empty-state compact">
            {t("database.cellEditor.multiCellHint", { count: selectionCount })}
          </div>
        ) : null}
        {renderEditor()}
      </div>
    );
  },
);
