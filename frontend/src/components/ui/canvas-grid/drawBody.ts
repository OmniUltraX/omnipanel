import type { GridCellDrawModel, GridRenderSnapshot, GridThemeTokens } from "./types";
import {
  FIELD_ACTION_BTN_SIZE,
  VALUE_BTN_SIZE,
  VALUE_BTN_RIGHT,
  getPinnedWidth,
  isPinnedDrawColumn,
  valueBtnRect,
} from "./geometry";

function resolveCellBackground(
  theme: GridThemeTokens,
  model: GridCellDrawModel,
  striped: boolean,
  hovered: boolean,
  isRownum: boolean,
  isRelation: boolean,
  isRelationDisplay: boolean,
): string {
  const selected = model.selected || model.dragSelected;
  if (selected && model.dirty) {
    if (model.dirtyKind === "insert") return theme.selectedDirtyInsertBg;
    if (model.dirtyKind === "delete") return theme.selectedDirtyDeleteBg;
    return theme.selectedDirtyUpdateBg;
  }
  if (selected) {
    return model.dragSelected && !model.selected ? theme.dragSelectedBg : theme.selectedBg;
  }
  if (model.rowSelected) {
    return hovered ? theme.surfaceHover : theme.rowSelectedBg;
  }
  if (model.dirty) {
    if (model.dirtyKind === "insert") return theme.dirtyInsertBg;
    if (model.dirtyKind === "delete") return theme.dirtyDeleteBg;
    return theme.dirtyUpdateBg;
  }
  if (isRelationDisplay) {
    if (hovered) return theme.surfaceHover;
    return striped ? theme.relationDisplayStripedBg : theme.relationDisplayBg;
  }
  if (isRelation) {
    if (hovered) return theme.surfaceHover;
    return striped ? theme.relationStripedBg : theme.relationBg;
  }
  if (isRownum) {
    if (hovered) return theme.surfaceHover;
    return striped ? theme.rownumStripedBg : theme.rownumBg;
  }
  if (hovered) return theme.surfaceHover;
  return striped ? theme.surface : theme.bg;
}

function resolveCellFg(theme: GridThemeTokens, model: GridCellDrawModel): string {
  if (model.dirty) {
    if (model.dirtyKind === "insert") return theme.dirtyInsertFg;
    if (model.dirtyKind === "delete") return theme.dirtyDeleteFg;
    return theme.dirtyUpdateFg;
  }
  if (model.kind === "placeholder") return theme.placeholderFg;
  if (model.mono || model.rowSelected || model.selected) return theme.fg;
  return theme.fg2;
}

function truncateToWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (maxWidth <= 0) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = "…";
  const ellipsisWidth = ctx.measureText(ellipsis).width;
  if (ellipsisWidth >= maxWidth) return "";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid)).width + ellipsisWidth <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return `${text.slice(0, lo)}${ellipsis}`;
}

function drawTag(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  theme: GridThemeTokens,
  dirty: boolean,
  kind: "null" | "empty",
) {
  const fg = dirty
    ? theme.dirtyNullTagFg
    : kind === "null"
      ? theme.nullTagFg
      : theme.emptyTagFg;
  const bg = dirty
    ? theme.dirtyNullTagBg
    : kind === "null"
      ? theme.nullTagBg
      : theme.emptyTagBg;
  const border = dirty
    ? theme.dirtyNullTagBorder
    : kind === "null"
      ? theme.nullTagBorder
      : theme.emptyTagBorder;

  ctx.save();
  ctx.font = `600 9px ${theme.fontFamily}`;
  const paddingX = 4;
  const width = Math.ceil(ctx.measureText(text).width + paddingX * 2);
  const height = 14;
  const top = y - height / 2;
  ctx.fillStyle = bg;
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  const r = 3;
  ctx.beginPath();
  ctx.moveTo(x + r, top);
  ctx.arcTo(x + width, top, x + width, top + height, r);
  ctx.arcTo(x + width, top + height, x, top + height, r);
  ctx.arcTo(x, top + height, x, top, r);
  ctx.arcTo(x, top, x + width, top, r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillText(text, x + paddingX, y + 0.5);
  ctx.restore();
}

function drawValueBtn(
  ctx: CanvasRenderingContext2D,
  cell: { x: number; y: number; width: number; height: number },
  theme: GridThemeTokens,
) {
  const btn = valueBtnRect(cell);
  ctx.save();
  ctx.fillStyle = theme.valueBtnBg;
  ctx.strokeStyle = theme.valueBtnBorder;
  ctx.lineWidth = 1;
  const r = 3;
  ctx.beginPath();
  ctx.moveTo(btn.x + r, btn.y);
  ctx.arcTo(btn.x + btn.width, btn.y, btn.x + btn.width, btn.y + btn.height, r);
  ctx.arcTo(btn.x + btn.width, btn.y + btn.height, btn.x, btn.y + btn.height, r);
  ctx.arcTo(btn.x, btn.y + btn.height, btn.x, btn.y, r);
  ctx.arcTo(btn.x, btn.y, btn.x + btn.width, btn.y, r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = theme.valueBtnFg;
  ctx.beginPath();
  const cx = btn.x + btn.width / 2;
  const cy = btn.y + btn.height / 2;
  ctx.arc(cx, cy, 4.2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx, cy - 1.2);
  ctx.lineTo(cx, cy + 2.4);
  ctx.moveTo(cx, cy - 3.2);
  ctx.lineTo(cx + 0.01, cy - 3.2);
  ctx.stroke();
  ctx.restore();
}

function drawFieldActions(
  ctx: CanvasRenderingContext2D,
  cell: { x: number; y: number; width: number; height: number },
  model: GridCellDrawModel,
  theme: GridThemeTokens,
) {
  const filterX = cell.x + cell.width - FIELD_ACTION_BTN_SIZE - 4;
  const sortX = filterX - FIELD_ACTION_BTN_SIZE - 2;
  const btnY = cell.y + (cell.height - FIELD_ACTION_BTN_SIZE) / 2;
  ctx.save();
  ctx.strokeStyle = model.fieldSortDir ? theme.accent : theme.fg2;
  ctx.fillStyle = model.fieldSortDir ? theme.accent : theme.fg2;
  ctx.lineWidth = 1.4;
  // sort chevron
  const sx = sortX + FIELD_ACTION_BTN_SIZE / 2;
  const sy = btnY + FIELD_ACTION_BTN_SIZE / 2;
  ctx.beginPath();
  if (model.fieldSortDir === "desc") {
    ctx.moveTo(sx - 3, sy - 1.5);
    ctx.lineTo(sx, sy + 2);
    ctx.lineTo(sx + 3, sy - 1.5);
  } else {
    ctx.moveTo(sx - 3, sy + 1.5);
    ctx.lineTo(sx, sy - 2);
    ctx.lineTo(sx + 3, sy + 1.5);
  }
  ctx.stroke();

  ctx.strokeStyle = model.fieldFiltered ? theme.accent : theme.fg2;
  const fx = filterX + FIELD_ACTION_BTN_SIZE / 2;
  const fy = btnY + FIELD_ACTION_BTN_SIZE / 2;
  ctx.beginPath();
  ctx.moveTo(fx - 4, fy - 3);
  ctx.lineTo(fx + 4, fy - 3);
  ctx.lineTo(fx + 1.5, fy + 0.5);
  ctx.lineTo(fx + 1.5, fy + 3.5);
  ctx.lineTo(fx - 1.5, fy + 2.5);
  ctx.lineTo(fx - 1.5, fy + 0.5);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

/** spreadsheet: 表数据网格；list: 库表列表等面板（仅行分割线） */
export type DrawGridBodyStyle = "spreadsheet" | "list";

export type DrawGridBodyOptions = {
  ctx: CanvasRenderingContext2D;
  snapshot: GridRenderSnapshot;
  theme: GridThemeTokens;
  rowOffsets: number[];
  scrollLeft: number;
  scrollTop: number;
  viewportWidth: number;
  viewportHeight: number;
  dpr: number;
  style?: DrawGridBodyStyle;
};

export function drawGridBody({
  ctx,
  snapshot,
  theme,
  rowOffsets,
  scrollLeft,
  scrollTop,
  viewportWidth,
  viewportHeight,
  dpr,
  style = "spreadsheet",
}: DrawGridBodyOptions): void {
  const width = Math.max(1, viewportWidth);
  const height = Math.max(1, viewportHeight);
  const isList = style === "list";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, height);

  const pinnedWidth = getPinnedWidth(snapshot.columns);
  const startY = scrollTop;
  const endY = scrollTop + height;

  let startRow = 0;
  let endRow = snapshot.rowCount - 1;
  for (let i = 0; i < snapshot.rowCount; i += 1) {
    const top = rowOffsets[i] ?? 0;
    const bottom = rowOffsets[i + 1] ?? top + snapshot.getRowHeight(i);
    if (bottom > startY) {
      startRow = i;
      break;
    }
  }
  for (let i = startRow; i < snapshot.rowCount; i += 1) {
    const top = rowOffsets[i] ?? 0;
    if (top >= endY) {
      endRow = i - 1;
      break;
    }
    endRow = i;
  }
  if (snapshot.rowCount === 0) return;

  ctx.font = `${theme.fontSize}px ${theme.fontFamily}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  // 列表模式：先画整行背景（hover / 选中），避免单元格竖线与斑马纹
  if (isList) {
    for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
      const rowTop = rowOffsets[rowIndex] ?? 0;
      const rowHeight = snapshot.getRowHeight(rowIndex);
      const screenY = rowTop - scrollTop;
      if (screenY + rowHeight <= 0 || screenY >= height) continue;

      const firstModel = snapshot.getCellModel(rowIndex, 0);
      const rowSelected = Boolean(firstModel?.rowSelected);
      const hovered = snapshot.hoverRow === rowIndex;
      if (rowSelected || hovered) {
        ctx.fillStyle = rowSelected
          ? hovered
            ? theme.surfaceHover
            : theme.rowSelectedBg
          : theme.surfaceHover;
        ctx.fillRect(0, screenY, width, rowHeight);
      }

      ctx.strokeStyle = theme.border;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, screenY + rowHeight - 0.5);
      ctx.lineTo(width, screenY + rowHeight - 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  const drawColumn = (colIndex: number, pinnedPass: boolean, pinnedScreenX?: number) => {
    const col = snapshot.columns[colIndex];
    // 行号 / 转置字段列强制按固定列绘制，避免 pinned 标记异常时跟着横滚跑掉
    const isPinnedCol = Boolean(col && isPinnedDrawColumn(col));
    if (!col || isPinnedCol !== pinnedPass) return;

    const screenX = pinnedPass
      ? (pinnedScreenX ?? 0)
      : col.x - scrollLeft;
    if (!pinnedPass) {
      if (screenX + col.width <= pinnedWidth) return;
      if (screenX >= width) return;
    } else if (screenX >= width) {
      return;
    }

    for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
      const model = snapshot.getCellModel(rowIndex, colIndex);
      if (!model) continue;
      const rowTop = rowOffsets[rowIndex] ?? 0;
      const rowHeight = snapshot.getRowHeight(rowIndex);
      const screenY = rowTop - scrollTop;
      if (screenY + rowHeight <= 0 || screenY >= height) continue;

      const striped = !isList && Math.floor(rowIndex / 2) % 2 === 1;
      const hovered = snapshot.hoverRow === rowIndex;

      if (!isList) {
        const bg = resolveCellBackground(
          theme,
          model,
          striped,
          hovered,
          col.isRowNum,
          col.isRelation,
          col.isRelationDisplay,
        );
        ctx.fillStyle = bg;
        ctx.fillRect(screenX, screenY, col.width, rowHeight);
      } else if (model.selected || model.dragSelected) {
        // 列表：仅单元格选区额外高亮（整行背景已画）
        ctx.fillStyle = theme.selectedBg;
        ctx.fillRect(screenX, screenY, col.width, rowHeight);
      }

      // clip cell content
      ctx.save();
      ctx.beginPath();
      ctx.rect(screenX, screenY, col.width, rowHeight);
      ctx.clip();

      const fg = resolveCellFg(theme, model);
      const textX = screenX + theme.cellPaddingX;
      const textY = screenY + rowHeight / 2;
      const reserveRight =
        (col.isFieldCol ? FIELD_ACTION_BTN_SIZE * 2 + 10 : 0) +
        (model.showValueBtn && hovered && snapshot.hoverCol === colIndex
          ? VALUE_BTN_SIZE + VALUE_BTN_RIGHT + 4
          : 0);
      const maxTextWidth = Math.max(0, col.width - theme.cellPaddingX * 2 - reserveRight);

      if (model.kind === "null") {
        drawTag(ctx, snapshot.nullLabel, textX, textY, theme, model.dirty, "null");
      } else if (model.kind === "empty") {
        drawTag(ctx, snapshot.emptyLabel, textX, textY, theme, model.dirty, "empty");
      } else {
        ctx.fillStyle = fg;
        ctx.font =
          model.dirty && model.dirtyKind !== "delete"
            ? `600 ${theme.fontSize}px ${theme.fontFamily}`
            : model.kind === "placeholder"
              ? `italic ${theme.fontSize}px ${theme.fontFamily}`
              : model.mono
                ? `500 ${theme.fontSize}px ${theme.fontFamily}`
                : `${theme.fontSize}px ${theme.fontFamily}`;
        if (model.dirtyKind === "delete") {
          const text = truncateToWidth(ctx, model.text, maxTextWidth);
          ctx.fillText(text, textX, textY);
          const tw = ctx.measureText(text).width;
          ctx.strokeStyle = theme.danger;
          ctx.beginPath();
          ctx.moveTo(textX, textY);
          ctx.lineTo(textX + tw, textY);
          ctx.stroke();
        } else {
          ctx.fillText(truncateToWidth(ctx, model.text, maxTextWidth), textX, textY);
        }
      }

      if (col.isFieldCol) {
        drawFieldActions(
          ctx,
          { x: screenX, y: screenY, width: col.width, height: rowHeight },
          model,
          theme,
        );
      }

      if (
        model.showValueBtn &&
        hovered &&
        snapshot.hoverCol === colIndex &&
        !col.isRowNum &&
        !col.isFieldCol &&
        !col.isRelationDisplay
      ) {
        drawValueBtn(ctx, { x: screenX, y: screenY, width: col.width, height: rowHeight }, theme);
      }

      ctx.restore();

      if (!isList) {
        // spreadsheet：单元格底边 + 右边框
        ctx.strokeStyle = theme.border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(screenX, screenY + rowHeight - 0.5);
        ctx.lineTo(screenX + col.width, screenY + rowHeight - 0.5);
        ctx.moveTo(screenX + col.width - 0.5, screenY);
        ctx.lineTo(screenX + col.width - 0.5, screenY + rowHeight);
        ctx.stroke();
      }
    }
  };

  // 先画滚动列，再画固定列，保证固定列盖住下方内容
  for (let i = 0; i < snapshot.columns.length; i += 1) {
    drawColumn(i, false);
  }
  let pinnedScreenX = 0;
  for (let i = 0; i < snapshot.columns.length; i += 1) {
    const col = snapshot.columns[i];
    if (!col || !isPinnedDrawColumn(col)) continue;
    drawColumn(i, true, pinnedScreenX);
    pinnedScreenX += col.width;
  }

  // 固定列右边线（列表模式不画）
  if (!isList && pinnedWidth > 0) {
    ctx.fillStyle = theme.border;
    ctx.fillRect(pinnedWidth, 0, 1, height);
  }
}
