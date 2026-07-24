import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import type { CellEditorKind } from "../cell_editor/types";
import { TemporalInput, type TemporalInputType } from "../cell_editor/TemporalInput";
import {
  clampCellOverlayPosition,
  CELL_OVERLAY_PREVIEW_MAX_HEIGHT,
  CELL_OVERLAY_VIEWPORT_MARGIN,
  computeCellOverlayDisplayWidth,
  computeCellOverlayMaxWidth,
  type CellOverlayState,
} from "./tableCellPreview";

const INLINE_EDITOR_MIN_HEIGHT = 32;
/** 原生分段控件太窄会截断；文本 + 按钮需要固定最小宽度 */
/** 与二进制日志 datetime-local 控件同宽量级，避免分段 UI 被挤扁 */
const TEMPORAL_OVERLAY_MIN_WIDTH: Record<"date" | "datetime" | "time", number> = {
  date: 168,
  datetime: 236,
  time: 128,
};

function syncTextareaHeight(
  textarea: HTMLTextAreaElement,
  anchor: { height: number },
  maxHeight: number,
) {
  const minHeight = Math.max(anchor.height, INLINE_EDITOR_MIN_HEIGHT);
  const cappedMaxHeight = Math.max(minHeight, maxHeight);

  textarea.style.maxHeight = `${cappedMaxHeight}px`;

  textarea.style.height = "0px";
  const naturalHeight = textarea.scrollHeight;
  const cappedHeight = Math.min(
    Math.max(naturalHeight, minHeight),
    cappedMaxHeight,
  );
  textarea.style.height = `${cappedHeight}px`;
  textarea.style.overflowY = naturalHeight > cappedMaxHeight ? "auto" : "hidden";
}

function inputTypeForKind(kind: CellEditorKind): TemporalInputType | "number" | "text" {
  switch (kind) {
    case "number":
      return "number";
    case "date":
      return "date";
    case "datetime":
      return "datetime-local";
    case "time":
      return "time";
    default:
      return "text";
  }
}

function isTemporalKind(kind: CellEditorKind): boolean {
  return kind === "date" || kind === "datetime" || kind === "time";
}

export function TableDataGridCellOverlay({
  overlay,
  onEditChange,
  onEditCommit,
  onEditCancel,
}: {
  overlay: CellOverlayState | null;
  onEditChange: (text: string) => void;
  onEditCommit: () => void;
  onEditCancel: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const editKind = overlay?.mode === "edit" ? overlay.editKind ?? "text" : "text";
  const usesTextarea =
    editKind === "text" || editKind === "json" || editKind === "binary";

  const layoutOverlay = useCallback(() => {
    const host = hostRef.current;
    if (!host || !overlay || overlay.mode !== "edit") return;

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const maxWidth = computeCellOverlayMaxWidth(viewportW);
    const kind = overlay.editKind ?? "text";
    const temporalMin =
      kind === "date" || kind === "datetime" || kind === "time"
        ? TEMPORAL_OVERLAY_MIN_WIDTH[kind]
        : 0;
    const measuredWidth = computeCellOverlayDisplayWidth(
      overlay,
      {
        value: overlay.value,
        columnType: overlay.columnType,
        editText: overlay.editText,
        mode: overlay.mode,
      },
      viewportW,
    );
    const displayWidth = Math.min(
      maxWidth,
      Math.max(measuredWidth, overlay.width, temporalMin),
    );

    host.style.position = "fixed";
    host.style.width = `${displayWidth}px`;
    host.style.maxWidth = `${maxWidth}px`;
    host.style.minWidth = `${Math.max(overlay.width, temporalMin)}px`;
    host.style.left = `${overlay.left}px`;
    host.style.top = `${overlay.top}px`;
    host.style.minHeight = `${Math.max(overlay.height, INLINE_EDITOR_MIN_HEIGHT)}px`;
    host.style.maxHeight = `${CELL_OVERLAY_PREVIEW_MAX_HEIGHT}px`;

    const textarea = textareaRef.current;
    if (textarea) {
      const maxHeight = Math.min(
        CELL_OVERLAY_PREVIEW_MAX_HEIGHT,
        Math.max(
          overlay.height,
          viewportH - CELL_OVERLAY_VIEWPORT_MARGIN - overlay.top,
        ),
      );
      syncTextareaHeight(textarea, overlay, maxHeight);
    }

    const hostRect = host.getBoundingClientRect();
    const clamped = clampCellOverlayPosition(
      { left: overlay.left, top: overlay.top },
      { width: hostRect.width, height: hostRect.height },
      viewportW,
      viewportH,
    );
    host.style.left = `${clamped.left}px`;
    host.style.top = `${clamped.top}px`;

    // clamp 未改变 top 时 maxHeight 不变，跳过第二次 syncTextareaHeight
    // 可省去一次 scrollHeight 读取（会强制 layout），编辑态逐键输入时收益明显。
    if (textarea && clamped.top !== overlay.top) {
      const maxHeight = Math.min(
        CELL_OVERLAY_PREVIEW_MAX_HEIGHT,
        Math.max(
          overlay.height,
          viewportH - CELL_OVERLAY_VIEWPORT_MARGIN - clamped.top,
        ),
      );
      syncTextareaHeight(textarea, overlay, maxHeight);
    }
  }, [overlay]);

  useLayoutEffect(() => {
    layoutOverlay();
  }, [layoutOverlay, overlay?.editText, editKind]);

  // 仅在进入某个单元格的编辑会话时 focus + 全选；
  // 不可依赖整个 overlay（editText 每键一变会反复 select，导致只能输入一个字符）。
  const editSessionKey =
    overlay?.mode === "edit" ? `${overlay.rowIndex}\0${overlay.column}` : null;

  useEffect(() => {
    if (!editSessionKey) return;

    const control = usesTextarea
      ? textareaRef.current
      : editKind === "boolean"
        ? selectRef.current
        : inputRef.current;
    control?.focus();
    if (control instanceof HTMLTextAreaElement || control instanceof HTMLInputElement) {
      if (control.type === "text" || control.type === "number" || usesTextarea) {
        control.select();
      }
    }
  }, [editSessionKey, editKind, usesTextarea]);

  useEffect(() => {
    if (!overlay || overlay.mode !== "edit") return;
    const scrollEl = document.querySelector(".db-data-table-wrap");
    const relayout = () => layoutOverlay();
    scrollEl?.addEventListener("scroll", relayout, { passive: true });
    window.addEventListener("resize", relayout);
    return () => {
      scrollEl?.removeEventListener("scroll", relayout);
      window.removeEventListener("resize", relayout);
    };
  }, [overlay?.mode, layoutOverlay]);

  const handleTextareaKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        onEditCancel();
        return;
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        onEditCommit();
      }
    },
    [onEditCommit, onEditCancel],
  );

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        onEditCancel();
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        onEditCommit();
      }
    },
    [onEditCommit, onEditCancel],
  );

  const handleSelectKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSelectElement>) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        onEditCommit();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onEditCancel();
      }
    },
    [onEditCommit, onEditCancel],
  );

  const stopMouse = {
    onMouseDown: (event: MouseEvent) => event.stopPropagation(),
    onClick: (event: MouseEvent) => event.stopPropagation(),
    onDoubleClick: (event: MouseEvent) => event.stopPropagation(),
  };

  if (!overlay || overlay.mode !== "edit") return null;

  const maxWidth = computeCellOverlayMaxWidth();

  return createPortal(
    <div
      ref={hostRef}
      className={`db-data-table-cell-overlay db-data-table-cell-overlay--edit db-data-table-cell-overlay--${editKind}`}
      style={{ maxWidth }}
      role="dialog"
      aria-label={overlay.column}
    >
      {editKind === "boolean" ? (
        <select
          ref={selectRef}
          className="db-data-table-inline-editor db-data-table-inline-editor--select"
          onKeyDown={handleSelectKeyDown}
          onBlur={onEditCommit}
          {...stopMouse}
          value={
            overlay.editText === "true" || overlay.editText === "1"
              ? "true"
              : overlay.editText === "false" || overlay.editText === "0"
                ? "false"
                : ""
          }
          onChange={(event) => onEditChange(event.target.value)}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : usesTextarea ? (
        <textarea
          ref={textareaRef}
          className="db-data-table-inline-editor db-data-table-inline-editor--textarea"
          rows={editKind === "json" ? 4 : 2}
          spellCheck={false}
          value={overlay.editText ?? ""}
          onChange={(event) => {
            onEditChange(event.target.value);
            layoutOverlay();
          }}
          onKeyDown={handleTextareaKeyDown}
          onBlur={onEditCommit}
          {...stopMouse}
        />
      ) : isTemporalKind(editKind) ? (
        <TemporalInput
          type={inputTypeForKind(editKind) as TemporalInputType}
          inputRef={inputRef}
          className="db-data-table-inline-editor db-data-table-inline-editor--input db-data-table-inline-editor--temporal"
          value={overlay.editText ?? ""}
          onChange={(value) => onEditChange(value)}
          onKeyDown={handleInputKeyDown}
          onBlur={onEditCommit}
          {...stopMouse}
        />
      ) : (
        <input
          ref={inputRef}
          type={inputTypeForKind(editKind) === "number" ? "number" : "text"}
          className="db-data-table-inline-editor db-data-table-inline-editor--input"
          value={overlay.editText ?? ""}
          onChange={(event) => onEditChange(event.target.value)}
          onKeyDown={handleInputKeyDown}
          onBlur={onEditCommit}
          {...stopMouse}
        />
      )}
    </div>,
    document.body,
  );
}
