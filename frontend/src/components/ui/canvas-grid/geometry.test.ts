import { describe, expect, it } from "vitest";

import {
  buildColumnOffsets,
  buildRowOffsets,
  findColumnAtX,
  findRowAtOffset,
  hitTestGrid,
  viewportToContent,
} from "./geometry";
import type { GridColumnDrawInfo, GridRenderSnapshot } from "./types";

function makeSnapshot(overrides?: Partial<GridRenderSnapshot>): GridRenderSnapshot {
  const widths = [40, 120, 120];
  const { columns: offs, totalWidth } = buildColumnOffsets(widths);
  const columns: GridColumnDrawInfo[] = offs.map((o, i) => ({
    id: i === 0 ? "__row_num__" : `c${i}`,
    x: o.x,
    width: o.width,
    pinned: i === 0,
    isRowNum: i === 0,
    isFieldCol: false,
    isRelation: false,
    isRelationDisplay: false,
  }));
  const getRowHeight = () => 32;
  const { offsets, totalHeight } = buildRowOffsets(10, getRowHeight);
  return {
    rowCount: 10,
    columnCount: columns.length,
    columns,
    totalWidth,
    totalHeight,
    defaultRowHeight: 32,
    getRowHeight,
    getRowOffset: (i) => offsets[i] ?? 0,
    getCellModel: (row, col) => ({
      kind: col === 0 ? "rownum" : "text",
      text: col === 0 ? String(row + 1) : `r${row}c${col}`,
      dirty: false,
      dirtyKind: "none",
      selected: false,
      dragSelected: false,
      canEdit: col > 0,
      showValueBtn: col > 0,
      fieldSortDir: null,
      fieldFiltered: false,
    }),
    hoverRow: null,
    hoverCol: null,
    nullLabel: "NULL",
    emptyLabel: "EMPTY",
    ...overrides,
  };
}

describe("canvas-grid geometry", () => {
  it("buildColumnOffsets accumulates widths", () => {
    const { columns, totalWidth } = buildColumnOffsets([10, 20, 30]);
    expect(totalWidth).toBe(60);
    expect(columns.map((c) => c.x)).toEqual([0, 10, 30]);
  });

  it("findRowAtOffset respects variable heights", () => {
    const heights = [20, 40, 30];
    const { offsets } = buildRowOffsets(3, (i) => heights[i]!);
    expect(findRowAtOffset(offsets, 0)).toBe(0);
    expect(findRowAtOffset(offsets, 19)).toBe(0);
    expect(findRowAtOffset(offsets, 20)).toBe(1);
    expect(findRowAtOffset(offsets, 59)).toBe(1);
    expect(findRowAtOffset(offsets, 60)).toBe(2);
  });

  it("viewportToContent maps pinned and scrolled columns", () => {
    expect(viewportToContent(10, 5, 100, 50, 40)).toEqual({
      contentX: 10,
      contentY: 55,
    });
    expect(viewportToContent(50, 5, 100, 50, 40)).toEqual({
      contentX: 150,
      contentY: 55,
    });
  });

  it("hitTestGrid returns rownum and cell regions", () => {
    const snapshot = makeSnapshot();
    const { offsets } = buildRowOffsets(10, () => 32);
    const rownumHit = hitTestGrid(snapshot, offsets, 10, 10, 0, 0);
    expect(rownumHit?.region).toBe("rownum");
    expect(rownumHit?.rowIndex).toBe(0);
    expect(rownumHit?.colIndex).toBe(0);

    const cellHit = hitTestGrid(snapshot, offsets, 80, 40, 0, 0);
    expect(cellHit?.region).toBe("cell");
    expect(cellHit?.rowIndex).toBe(1);
    expect(cellHit?.colIndex).toBe(1);
  });

  it("findColumnAtX finds content columns", () => {
    const snapshot = makeSnapshot();
    expect(findColumnAtX(snapshot.columns, 0, 0, 40)).toBe(0);
    expect(findColumnAtX(snapshot.columns, 40, 0, 40)).toBe(1);
    expect(findColumnAtX(snapshot.columns, 200, 0, 40)).toBe(2);
  });

  it("hitTestGrid detects row resize zone", () => {
    const snapshot = makeSnapshot();
    const { offsets } = buildRowOffsets(10, () => 32);
    const hit = hitTestGrid(snapshot, offsets, 10, 31, 0, 0);
    expect(hit?.region).toBe("rowResize");
  });
});
