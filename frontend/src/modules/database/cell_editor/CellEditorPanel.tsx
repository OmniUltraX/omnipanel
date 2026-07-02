import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useI18n } from "../../../i18n";
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
  onApply: (value: unknown) => void;
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

export const CellEditorPanel = forwardRef<CellEditorPanelHandle, CellEditorPanelProps>(
  function CellEditorPanel(
    { columnName, columnType, currentValue, cellKey, onApply },
    ref,
  ) {
    const { t } = useI18n();
    const bodyRef = useRef<HTMLDivElement>(null);
    const editTextRef = useRef("");
    const cellKeyRef = useRef(cellKey);
    const editorKind = useMemo(() => detectCellEditorKind(columnType), [columnType]);
    const rawText = useMemo(() => formatCellValue(currentValue), [currentValue]);
    const normalized = useMemo(
      () => normalizeForKind(editorKind, rawText),
      [editorKind, rawText],
    );
    const [editText, setEditText] = useState(normalized);
    editTextRef.current = editText;
    const isNull = currentValue === null || currentValue === undefined;

    useEffect(() => {
      if (cellKeyRef.current === cellKey) return;
      cellKeyRef.current = cellKey;
      setEditText(normalized);
    }, [cellKey, normalized]);

    const applyValue = useCallback(
      (value: string) => {
        if (!columnName) return;
        const parsed = parseCellValue(editorKind, value);
        if (isSameCellValue(currentValue, parsed)) return;
        onApply(parsed);
      },
      [columnName, currentValue, editorKind, onApply],
    );

    useImperativeHandle(
      ref,
      () => ({
        commitIfDirty: () => {
          applyValue(editTextRef.current);
        },
        focusEditor: () => {
          const control = bodyRef.current?.querySelector<HTMLElement>(
            "input, textarea, select, button",
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
        case "json":
          return <JsonEditor {...props} />;
        case "binary":
          return <TextEditor {...props} />;
        default:
          return isNull ? <NullEditor {...props} /> : <TextEditor {...props} />;
      }
    };

    if (!columnName || !cellKey) {
      return (
        <div className="db-cell-editor-panel db-cell-editor-panel--empty">
          <div className="empty-state compact">{t("database.cellEditor.selectCellHint")}</div>
        </div>
      );
    }

    return (
      <div ref={bodyRef} className="db-cell-editor-panel">
        {renderEditor()}
      </div>
    );
  },
);
