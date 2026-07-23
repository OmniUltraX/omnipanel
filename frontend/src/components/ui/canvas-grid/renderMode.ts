import type { CanvasGridRenderMode } from "./types";

export const CANVAS_GRID_RENDER_MODE_STORAGE_KEY = "omnipanel.ui.canvasGridRenderMode";
/** 表数据网格独立存储键（兼容旧值） */
export const DB_GRID_RENDER_MODE_STORAGE_KEY = "omnipanel.db.gridRenderMode";
/** 面板表格独立存储键 */
export const PANEL_GRID_RENDER_MODE_STORAGE_KEY = "omnipanel.ui.panelGridRenderMode";

export const DEFAULT_CANVAS_GRID_RENDER_MODE: CanvasGridRenderMode = "canvas";

function readMode(key: string, fallback: CanvasGridRenderMode): CanvasGridRenderMode {
  try {
    const value = localStorage.getItem(key);
    if (value === "dom" || value === "canvas") return value;
  } catch {
    /* ignore */
  }
  return fallback;
}

function writeMode(key: string, mode: CanvasGridRenderMode): void {
  try {
    localStorage.setItem(key, mode);
  } catch {
    /* ignore */
  }
}

export function readStoredCanvasGridRenderMode(): CanvasGridRenderMode {
  return readMode(CANVAS_GRID_RENDER_MODE_STORAGE_KEY, DEFAULT_CANVAS_GRID_RENDER_MODE);
}

export function writeStoredCanvasGridRenderMode(mode: CanvasGridRenderMode): void {
  writeMode(CANVAS_GRID_RENDER_MODE_STORAGE_KEY, mode);
}

export function readStoredDbGridRenderMode(): CanvasGridRenderMode {
  return readMode(DB_GRID_RENDER_MODE_STORAGE_KEY, DEFAULT_CANVAS_GRID_RENDER_MODE);
}

export function writeStoredDbGridRenderMode(mode: CanvasGridRenderMode): void {
  writeMode(DB_GRID_RENDER_MODE_STORAGE_KEY, mode);
}

export function readStoredPanelGridRenderMode(): CanvasGridRenderMode {
  return readMode(PANEL_GRID_RENDER_MODE_STORAGE_KEY, DEFAULT_CANVAS_GRID_RENDER_MODE);
}

export function writeStoredPanelGridRenderMode(mode: CanvasGridRenderMode): void {
  writeMode(PANEL_GRID_RENDER_MODE_STORAGE_KEY, mode);
}

/** @deprecated 使用 readStoredDbGridRenderMode */
export const GRID_RENDER_MODE_STORAGE_KEY = DB_GRID_RENDER_MODE_STORAGE_KEY;
export const DEFAULT_GRID_RENDER_MODE = DEFAULT_CANVAS_GRID_RENDER_MODE;
export const readStoredGridRenderMode = readStoredDbGridRenderMode;
export const writeStoredGridRenderMode = writeStoredDbGridRenderMode;
