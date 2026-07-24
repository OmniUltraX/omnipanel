import type { LsEntry } from "./parseLsListing";
import { lsEntryDisplayName } from "./parseLsListing";

export { lsEntryDisplayName };

/** 容器尚未测量时的回退宽度（字符数） */
export const LS_GRID_TERMINAL_WIDTH_FALLBACK = 120;

/** 列与列之间的空格数（与 GNU ls 一致） */
export const LS_GRID_COLUMN_GAP = 2;

export type LsGridColumn = {
  entries: LsEntry[];
  width: number;
};

export type LsGridLayout = {
  columns: LsGridColumn[];
};

function buildColumnsForNcol(
  entries: LsEntry[],
  ncol: number,
  columnGap: number,
): { columns: LsGridColumn[]; totalWidth: number } {
  const nrow = Math.ceil(entries.length / ncol);
  const columns: LsGridColumn[] = [];
  let totalWidth = 0;

  for (let c = 0; c < ncol; c += 1) {
    const colEntries: LsEntry[] = [];
    for (let r = 0; r < nrow; r += 1) {
      const index = r + c * nrow;
      if (index < entries.length) {
        colEntries.push(entries[index]!);
      }
    }
    if (colEntries.length === 0) continue;

    const colWidth = Math.max(...colEntries.map((e) => lsEntryDisplayName(e).length), 1);
    columns.push({ entries: colEntries, width: colWidth });
    totalWidth += colWidth;
  }

  if (columns.length > 1) {
    totalWidth += (columns.length - 1) * columnGap;
  }

  return { columns, totalWidth };
}

/**
 * GNU ls 纵列填充：在终端宽度内取尽可能多的列；
 * 每列宽度仅由该列最长文件名决定（非全局最长）。
 */
export function layoutLsGrid(
  entries: LsEntry[],
  terminalWidth = LS_GRID_TERMINAL_WIDTH_FALLBACK,
  columnGap = LS_GRID_COLUMN_GAP,
): LsGridLayout {
  if (entries.length === 0) {
    return { columns: [] };
  }

  const width = Math.max(terminalWidth, 1);
  const singleWidth = Math.max(...entries.map((e) => lsEntryDisplayName(e).length), 1);
  let best: LsGridColumn[] = [{ entries, width: singleWidth }];

  for (let ncol = entries.length; ncol >= 1; ncol -= 1) {
    const { columns, totalWidth } = buildColumnsForNcol(entries, ncol, columnGap);
    if (totalWidth <= width) {
      best = columns;
      break;
    }
  }

  return { columns: best };
}

// 字体签名缓存：fontFamily/fontSize/fontWeight 未变时复用测量结果，
// 避免每次调用都创建 canvas + getComputedStyle + measureText（终端 resize/relayout 高频触发）。
let monoCharWidthCache: { signature: string; width: number } | null = null;

/** 测量等宽字体下单字符像素宽度 */
export function measureMonoCharWidthPx(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const fontWeight = style.fontWeight;
  const fontSize = style.fontSize;
  const fontFamily = style.fontFamily;
  const signature = `${fontWeight}|${fontSize}|${fontFamily}`;
  if (monoCharWidthCache && monoCharWidthCache.signature === signature) {
    return monoCharWidthCache.width;
  }

  let width: number;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.font = `${fontWeight} ${fontSize} ${fontFamily}`;
    const w = ctx.measureText("0").width;
    if (w > 0) {
      width = w;
      monoCharWidthCache = { signature, width };
      return width;
    }
  }
  const parsed = parseFloat(fontSize);
  width = Number.isFinite(parsed) ? parsed * 0.6 : 7.2;
  monoCharWidthCache = { signature, width };
  return width;
}

export function pxToTerminalColumns(element: HTMLElement, px: number): number {
  const charWidth = measureMonoCharWidthPx(element);
  return Math.max(20, Math.floor(px / charWidth));
}
