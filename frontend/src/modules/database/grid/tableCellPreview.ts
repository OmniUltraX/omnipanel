import type { CellEditorKind } from "../cell_editor/types";
import type { CodeEditorLanguage } from "../../../components/ui/content/CodeEditor";

import {

  isPreviewWebUrl as isCellWebUrl,

  normalizePreviewWebUrl as normalizeCellWebUrl,

} from "../../../lib/contentPreview";



export { isCellWebUrl, normalizeCellWebUrl };



/** 与 `.db-cell-preview-drawer` 一致的浮层宽度策略 */

export const CELL_PREVIEW_DRAWER_MAX_WIDTH = 560;

export const CELL_PREVIEW_DRAWER_VIEWPORT_WIDTH_RATIO = 0.92;

export const CELL_OVERLAY_VIEWPORT_MARGIN = 8;

export const CELL_OVERLAY_PREVIEW_MAX_HEIGHT = 320;



export type CellOverlayAnchor = {

  left: number;

  top: number;

  width: number;

  height: number;

};



export type CellOverlayMode = "preview" | "edit";



export type CellOverlayState = CellOverlayAnchor & {

  mode: CellOverlayMode;

  /** 右键/Alt 触发的预览不因 mouseleave 关闭 */

  pinned?: boolean;

  column: string;

  rowIndex: number;

  row: Record<string, unknown>;

  value: unknown;

  columnType?: string;

  editKind?: CellEditorKind;

  editText?: string;

};



/** 读取单元格在视口中的锚点矩形 */

export function getCellOverlayAnchor(td: HTMLElement): CellOverlayAnchor {

  const rect = td.getBoundingClientRect();

  return {

    left: rect.left,

    top: rect.top,

    width: rect.width,

    height: rect.height,

  };

}



/** 单元格浮层最大宽度，与预览抽屉 `min(560px, 92vw)` 对齐 */

export function computeCellOverlayMaxWidth(viewportWidth = window.innerWidth): number {

  return Math.min(

    CELL_PREVIEW_DRAWER_MAX_WIDTH,

    viewportWidth * CELL_PREVIEW_DRAWER_VIEWPORT_WIDTH_RATIO

      - CELL_OVERLAY_VIEWPORT_MARGIN * 2,

  );

}



/** 将浮层位置约束在视口内 */

export function clampCellOverlayPosition(

  position: { left: number; top: number },

  size: { width: number; height: number },

  viewportWidth = window.innerWidth,

  viewportHeight = window.innerHeight,

  margin = CELL_OVERLAY_VIEWPORT_MARGIN,

): { left: number; top: number } {

  let { left, top } = position;



  if (left + size.width > viewportWidth - margin) {

    left = Math.max(margin, viewportWidth - margin - size.width);

  }

  if (left < margin) {

    left = margin;

  }

  if (top + size.height > viewportHeight - margin) {

    top = Math.max(margin, viewportHeight - margin - size.height);

  }

  if (top < margin) {

    top = margin;

  }



  return { left, top };

}



export type CellPreviewState = {
  column: string;
  rowIndex: number;
  row: Record<string, unknown>;
  value: unknown;
  columnType?: string;
};

export function buildCellPreviewState(
  cell: {
    column: string;
    rowIndex: number;
    row: Record<string, unknown>;
    value: unknown;
    columnType?: string;
  },
): CellPreviewState {
  return {
    column: cell.column,
    rowIndex: cell.rowIndex,
    row: cell.row,
    value: cell.value,
    columnType: cell.columnType,
  };
}

export function buildCellPreviewOverlay(

  anchor: CellOverlayAnchor,

  cell: {

    column: string;

    rowIndex: number;

    row: Record<string, unknown>;

    value: unknown;

    columnType?: string;

  },

  opts?: { pinned?: boolean },

): CellOverlayState {

  return {

    ...anchor,

    mode: "preview",

    pinned: opts?.pinned,

    column: cell.column,

    rowIndex: cell.rowIndex,

    row: cell.row,

    value: cell.value,

    columnType: cell.columnType,

  };

}



export function buildCellEditOverlay(

  anchor: CellOverlayAnchor,

  cell: {

    column: string;

    rowIndex: number;

    row: Record<string, unknown>;

    value: unknown;

    columnType?: string;

    editKind: CellEditorKind;

    editText: string;

  },

): CellOverlayState {

  return {

    ...anchor,

    mode: "edit",

    column: cell.column,

    rowIndex: cell.rowIndex,

    row: cell.row,

    value: cell.value,

    columnType: cell.columnType,

    editKind: cell.editKind,

    editText: cell.editText,

  };

}



export type CellPreviewContent =

  | { kind: "json"; value: object }

  | { kind: "text"; text: string };



export function isJsonColumnType(columnType?: string): boolean {
  if (!columnType) return false;
  const lower = columnType.toLowerCase();
  return lower === "json" || lower === "jsonb" || lower.includes("json");
}

/** text / longtext / mediumtext / char / varchar 等按纯文本预览，不做 JSON 结构推断 */
export function isPlainTextColumnType(columnType?: string): boolean {
  if (!columnType) return false;
  if (isJsonColumnType(columnType)) return false;
  const lower = columnType.toLowerCase();
  return (
    lower.includes("text") ||
    lower.includes("char") ||
    lower.includes("clob") ||
    lower.includes("string") ||
    lower === "uuid" ||
    lower.includes("enum")
  );
}

export function resolveCellPreviewCodeLanguage(
  columnType: string | undefined,
  content: CellPreviewContent,
): CodeEditorLanguage | undefined {
  if (content.kind === "json") return "json";
  if (content.kind !== "text") return undefined;
  if (isJsonColumnType(columnType)) return "json";
  if (isPlainTextColumnType(columnType)) return "text";
  const trimmed = content.text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  return "text";
}

/** 解析单元格预览内容：JSON 对象/数组用 JsonView，其余用纯文本。 */
export function resolveCellPreviewContent(
  value: unknown,
  columnType?: string,
): CellPreviewContent {
  if (value === null || value === undefined) {
    return { kind: "text", text: "NULL" };
  }

  if (typeof value === "object") {
    return { kind: "json", value: value as object };
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    const tryJson =
      isJsonColumnType(columnType) ||
      (!isPlainTextColumnType(columnType) &&
        (trimmed.startsWith("{") || trimmed.startsWith("[")));

    if (tryJson && trimmed.length > 0) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === "object") {
          return { kind: "json", value: parsed as object };
        }
      } catch {
        // 非合法 JSON 字符串，按文本展示
      }
    }

    return { kind: "text", text: value };
  }

  return { kind: "text", text: String(value) };
}

const CELL_OVERLAY_FONT =
  '11px "Maple Mono NF CN Light", monospace';
const CELL_OVERLAY_HORIZONTAL_CHROME = 18;

let cellOverlayMeasureCanvas: HTMLCanvasElement | null = null;

function measureCellOverlayTextWidth(text: string): number {
  if (!text) return 0;
  if (typeof document === "undefined") return 0;

  cellOverlayMeasureCanvas ??= document.createElement("canvas");
  const ctx = cellOverlayMeasureCanvas.getContext("2d");
  if (!ctx) return 0;

  ctx.font = CELL_OVERLAY_FONT;
  let longest = 0;
  for (const line of text.split("\n")) {
    longest = Math.max(longest, ctx.measureText(line).width);
  }
  return Math.ceil(longest);
}

/** 根据内容估算浮层展示宽度，与预览浮层 `min(560px, 92vw)` 策略一致 */
export function estimateCellOverlayDisplayWidth(
  cellWidth: number,
  text: string,
  maxWidth = computeCellOverlayMaxWidth(),
): number {
  const contentWidth =
    measureCellOverlayTextWidth(text) + CELL_OVERLAY_HORIZONTAL_CHROME;
  if (contentWidth <= 0) {
    return cellWidth;
  }
  return Math.max(cellWidth, Math.min(maxWidth, contentWidth));
}

function resolveCellOverlayMeasureText(
  value: unknown,
  columnType?: string,
  editText?: string,
): string {
  if (editText !== undefined) {
    return editText;
  }

  const preview = resolveCellPreviewContent(value, columnType);
  if (preview.kind === "json") {
    return JSON.stringify(preview.value, null, 2);
  }
  return preview.text;
}

/** 预览 / 编辑浮层共用宽度，避免编辑框仅贴合单元格宽度 */
export function computeCellOverlayDisplayWidth(
  anchor: Pick<CellOverlayAnchor, "width">,
  params: {
    value: unknown;
    columnType?: string;
    editText?: string;
    mode: CellOverlayMode;
  },
  viewportWidth = window.innerWidth,
): number {
  const maxWidth = computeCellOverlayMaxWidth(viewportWidth);
  const text = resolveCellOverlayMeasureText(
    params.value,
    params.columnType,
    params.mode === "edit" ? params.editText : undefined,
  );
  return estimateCellOverlayDisplayWidth(anchor.width, text, maxWidth);
}

