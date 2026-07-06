import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../../i18n";
import type { RowDiffFieldSide } from "./rowDiffResolutions";

const PICKER_HIDE_DELAY_MS = 100;

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  const text = String(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

export function RowDiffConflictCell({
  rowKey,
  columnName,
  colWidth,
  sourceVal,
  targetVal,
  resolution,
  onPick,
}: {
  rowKey: string;
  columnName: string;
  colWidth: number;
  sourceVal: unknown;
  targetVal: unknown;
  resolution?: RowDiffFieldSide;
  onPick: (rowKey: string, columnName: string, side: RowDiffFieldSide) => void;
}) {
  const { t } = useI18n();
  const cellRef = useRef<HTMLTableCellElement>(null);
  const pickerHoverRef = useRef(false);
  const hideTimerRef = useRef<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerStyle, setPickerStyle] = useState<{ left: number; top: number } | null>(null);

  const updatePickerPosition = useCallback(() => {
    const cell = cellRef.current;
    if (!cell) {
      return;
    }
    const rect = cell.getBoundingClientRect();
    setPickerStyle({
      left: rect.left + rect.width / 2,
      top: rect.top - 6,
    });
  }, []);

  const openPicker = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    updatePickerPosition();
    setPickerOpen(true);
  }, [updatePickerPosition]);

  const closePicker = useCallback(() => {
    setPickerOpen(false);
    setPickerStyle(null);
  }, []);

  const scheduleClosePicker = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
    }
    hideTimerRef.current = window.setTimeout(() => {
      if (!pickerHoverRef.current) {
        closePicker();
      }
    }, PICKER_HIDE_DELAY_MS);
  }, [closePicker]);

  const handlePick = useCallback(
    (side: RowDiffFieldSide) => {
      onPick(rowKey, columnName, side);
      pickerHoverRef.current = false;
      closePicker();
    },
    [closePicker, columnName, onPick, rowKey],
  );

  useEffect(() => {
    if (!pickerOpen) {
      return;
    }

    const onReposition = () => updatePickerPosition();
    const onScroll = () => closePicker();

    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onScroll, true);

    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [closePicker, pickerOpen, updatePickerPosition]);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, []);

  const sourceText = formatCellValue(sourceVal);
  const targetText = formatCellValue(targetVal);
  const pickedText =
    resolution === "source" ? sourceText : resolution === "target" ? targetText : null;

  const pickerNode =
    pickerOpen && pickerStyle
      ? createPortal(
          <div
            className="db-toolbox-row-diff-cell-picker db-toolbox-row-diff-cell-picker--portal"
            style={{
              position: "fixed",
              left: pickerStyle.left,
              top: pickerStyle.top,
              transform: "translate(-50%, -100%)",
            }}
            role="group"
            aria-label={t("database.toolbox.side.rowDiffCellPickerLabel")}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => {
              pickerHoverRef.current = true;
              if (hideTimerRef.current !== null) {
                window.clearTimeout(hideTimerRef.current);
                hideTimerRef.current = null;
              }
            }}
            onMouseLeave={() => {
              pickerHoverRef.current = false;
              scheduleClosePicker();
            }}
          >
            <button
              type="button"
              className={`db-toolbox-row-diff-cell-picker-btn db-toolbox-row-diff-cell-picker-btn--yes${resolution === "source" ? " db-toolbox-row-diff-cell-picker-btn--active" : ""}`}
              title={t("database.toolbox.side.rowDiffPickYesTitle")}
              onClick={() => handlePick("source")}
            >
              {t("database.toolbox.side.rowDiffPickYes")}
            </button>
            <button
              type="button"
              className={`db-toolbox-row-diff-cell-picker-btn db-toolbox-row-diff-cell-picker-btn--no${resolution === "target" ? " db-toolbox-row-diff-cell-picker-btn--active" : ""}`}
              title={t("database.toolbox.side.rowDiffPickNoTitle")}
              onClick={() => handlePick("target")}
            >
              {t("database.toolbox.side.rowDiffPickNo")}
            </button>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <td
        ref={cellRef}
        data-col-id={columnName}
        style={{ width: colWidth, minWidth: colWidth, maxWidth: colWidth }}
        className={`db-toolbox-row-diff-cell--conflict${pickerOpen ? " db-toolbox-row-diff-cell--picker-open" : ""}${resolution ? ` db-toolbox-row-diff-cell--resolved-${resolution}` : ""}`}
        onMouseEnter={openPicker}
        onMouseLeave={scheduleClosePicker}
      >
        <div className="db-toolbox-row-diff-cell-inner">
          {pickedText !== null ? (
            <span
              className={`db-toolbox-row-diff-cell-picked db-toolbox-row-diff-cell-picked--${resolution}`}
              title={pickedText}
            >
              {pickedText}
            </span>
          ) : (
            <span className="db-toolbox-row-diff-cell-pending" title={`${sourceText} → ${targetText}`}>
              {sourceText} → {targetText}
            </span>
          )}
        </div>
      </td>
      {pickerNode}
    </>
  );
}
