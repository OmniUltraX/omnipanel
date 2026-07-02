import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { ContentPreviewView } from "../../../components/ui/ContentPreviewView";
import {
  clampCellOverlayPosition,
  CELL_OVERLAY_PREVIEW_MAX_HEIGHT,
  CELL_OVERLAY_VIEWPORT_MARGIN,
  computeCellOverlayDisplayWidth,
  computeCellOverlayMaxWidth,
  resolveCellPreviewContent,
  type CellOverlayState,
} from "./tableCellPreview";

const INLINE_EDITOR_MIN_HEIGHT = 32;

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

  const previewContent = useMemo(() => {
    if (!overlay || overlay.mode !== "preview") return null;
    return resolveCellPreviewContent(overlay.value, overlay.columnType);
  }, [overlay]);

  const layoutOverlay = useCallback(() => {
    const host = hostRef.current;
    if (!host || !overlay) return;

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const maxWidth = computeCellOverlayMaxWidth(viewportW);
    const displayWidth = computeCellOverlayDisplayWidth(
      overlay,
      {
        value: overlay.value,
        columnType: overlay.columnType,
        editText: overlay.editText,
        mode: overlay.mode,
      },
      viewportW,
    );

    host.style.position = "fixed";
    host.style.width = `${displayWidth}px`;
    host.style.maxWidth = `${maxWidth}px`;
    host.style.minWidth = `${overlay.width}px`;
    host.style.left = `${overlay.left}px`;
    host.style.top = `${overlay.top}px`;

    if (overlay.mode === "preview") {
      host.style.minHeight = `${overlay.height}px`;
      host.style.maxHeight = `${CELL_OVERLAY_PREVIEW_MAX_HEIGHT}px`;
    } else {
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

    if (overlay.mode === "edit") {
      const textarea = textareaRef.current;
      if (textarea) {
        const maxHeight = Math.min(
          CELL_OVERLAY_PREVIEW_MAX_HEIGHT,
          Math.max(
            overlay.height,
            viewportH - CELL_OVERLAY_VIEWPORT_MARGIN - clamped.top,
          ),
        );
        syncTextareaHeight(textarea, overlay, maxHeight);
      }
    }
  }, [overlay]);

  useLayoutEffect(() => {
    layoutOverlay();
  }, [layoutOverlay, overlay?.mode, overlay?.editText, previewContent]);

  useEffect(() => {
    if (!overlay) return;
    const scrollEl = document.querySelector(".db-data-table-wrap");
    const relayout = () => layoutOverlay();
    scrollEl?.addEventListener("scroll", relayout, { passive: true });
    window.addEventListener("resize", relayout);

    if (overlay.mode === "edit") {
      const control = overlay.editKind === "boolean" ? selectRef.current : textareaRef.current;
      control?.focus();
      if (control instanceof HTMLTextAreaElement) {
        control.select();
      }
    }

    return () => {
      scrollEl?.removeEventListener("scroll", relayout);
      window.removeEventListener("resize", relayout);
    };
  }, [overlay, layoutOverlay]);

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

  if (!overlay) return null;

  const maxWidth = computeCellOverlayMaxWidth();

  return createPortal(
    <div
      ref={hostRef}
      className={`db-data-table-cell-overlay db-data-table-cell-overlay--${overlay.mode}`}
      style={{ maxWidth }}
      role={overlay.mode === "preview" ? "tooltip" : "dialog"}
      aria-label={overlay.column}
    >
      {overlay.mode === "preview" && previewContent ? (
        <div className="db-data-table-cell-overlay-preview">
          <ContentPreviewView
            status="ready"
            content={previewContent}
            showTextModeToolbar={false}
            className="content-preview-view--embedded db-data-table-cell-overlay-preview-view"
            contentResetKey={`${overlay.column}|${overlay.rowIndex}|${overlay.mode}`}
          />
        </div>
      ) : null}
      {overlay.mode === "edit" && overlay.editKind === "boolean" ? (
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
      ) : null}
      {overlay.mode === "edit" && overlay.editKind !== "boolean" ? (
        <textarea
          ref={textareaRef}
          className="db-data-table-inline-editor db-data-table-inline-editor--textarea"
          rows={2}
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
      ) : null}
    </div>,
    document.body,
  );
}
