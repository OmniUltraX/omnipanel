import { describe, expect, it } from "vitest";

import { TRANSPOSE_FIELD_COL, transposeRowColId } from "../tableDataGridConstants";
import { buildGridSnapshotBundle } from "./buildGridSnapshot";

describe("buildGridSnapshot", () => {
  it("builds rownum and text cells with selection", () => {
    const { snapshot, rowOffsets } = buildGridSnapshotBundle({
      leafColumns: [
        { id: "__row_num__", getSize: () => 40 },
        { id: "name", getSize: () => 120 },
      ],
      tableRows: [
        { index: 0, original: { name: "alice" } },
        { index: 1, original: { name: null } },
      ],
      resolveColumnWidth: (_id, size) => size,
      rowHeights: {},
      defaultRowHeight: 32,
      transposed: false,
      columnMetaMap: {
        name: { name: "name", type: "varchar", isPk: false, isFk: false, nullable: true },
      },
      pkCols: [],
      displayCellOverrides: null,
      displayDirtyRowKeys: null,
      deletedRowKeys: null,
      cellRange: { start: { row: 0, col: 1 }, end: { row: 0, col: 1 } },
      dragRange: null,
      selectedRows: new Set(),
      hoverRow: null,
      hoverCol: null,
      page: 0,
      pageSize: 100,
      hasCellEdit: true,
      enableValuePanelAffordance: true,
      relationHighlightColumnIds: new Set(),
      enableSort: false,
      sortColumn: null,
      sortDirection: null,
      canFilter: false,
      filterColumnNames: new Set(),
      autoIncrementPlaceholder: "(auto)",
      nullLabel: "NULL",
      emptyLabel: "EMPTY",
    });

    expect(snapshot.totalHeight).toBe(64);
    expect(rowOffsets).toEqual([0, 32, 64]);
    expect(snapshot.getCellModel(0, 0)?.kind).toBe("rownum");
    expect(snapshot.getCellModel(0, 0)?.text).toBe("1");
    expect(snapshot.getCellModel(0, 1)?.kind).toBe("text");
    expect(snapshot.getCellModel(0, 1)?.text).toBe("alice");
    expect(snapshot.getCellModel(0, 1)?.selected).toBe(true);
    expect(snapshot.getCellModel(1, 1)?.kind).toBe("null");
  });

  it("reads transposed paint rows by __field__/__row__ keys (not original row shape)", () => {
    const transposedRows = [
      {
        [TRANSPOSE_FIELD_COL]: "id",
        [transposeRowColId(0)]: 1,
        [transposeRowColId(1)]: 2,
      },
      {
        [TRANSPOSE_FIELD_COL]: "name",
        [transposeRowColId(0)]: "alice",
        [transposeRowColId(1)]: "bob",
      },
    ];
    const { snapshot } = buildGridSnapshotBundle({
      leafColumns: [
        { id: TRANSPOSE_FIELD_COL, getSize: () => 108 },
        { id: transposeRowColId(0), getSize: () => 120 },
        { id: transposeRowColId(1), getSize: () => 120 },
      ],
      tableRows: transposedRows.map((original, index) => ({ index, original })),
      resolveColumnWidth: (_id, size) => size,
      rowHeights: {},
      defaultRowHeight: 32,
      transposed: true,
      columnMetaMap: {
        id: { name: "id", type: "int", isPk: true, isFk: false, nullable: false },
        name: { name: "name", type: "varchar", isPk: false, isFk: false, nullable: true },
      },
      pkCols: [{ name: "id" }],
      displayCellOverrides: null,
      displayDirtyRowKeys: null,
      deletedRowKeys: null,
      cellRange: null,
      dragRange: null,
      selectedRows: new Set(),
      hoverRow: null,
      hoverCol: null,
      page: 0,
      pageSize: 100,
      hasCellEdit: true,
      enableValuePanelAffordance: false,
      relationHighlightColumnIds: new Set(),
      enableSort: false,
      sortColumn: null,
      sortDirection: null,
      canFilter: false,
      filterColumnNames: new Set(),
      autoIncrementPlaceholder: "(auto)",
      nullLabel: "NULL",
      emptyLabel: "EMPTY",
    });

    expect(snapshot.getCellModel(0, 0)?.kind).toBe("field");
    expect(snapshot.getCellModel(0, 0)?.text).toBe("id");
    expect(snapshot.getCellModel(0, 1)?.text).toBe("1");
    expect(snapshot.getCellModel(0, 2)?.text).toBe("2");
    expect(snapshot.getCellModel(1, 0)?.text).toBe("name");
    expect(snapshot.getCellModel(1, 1)?.text).toBe("alice");
    expect(snapshot.getCellModel(1, 2)?.text).toBe("bob");

    // 若误用原始行形状去画横置列，取值会全是 undefined → null
    const { snapshot: broken } = buildGridSnapshotBundle({
      leafColumns: [
        { id: TRANSPOSE_FIELD_COL, getSize: () => 108 },
        { id: transposeRowColId(0), getSize: () => 120 },
      ],
      tableRows: [
        { index: 0, original: { id: 1, name: "alice" } },
      ],
      resolveColumnWidth: (_id, size) => size,
      rowHeights: {},
      defaultRowHeight: 32,
      transposed: true,
      columnMetaMap: null,
      pkCols: [],
      displayCellOverrides: null,
      displayDirtyRowKeys: null,
      deletedRowKeys: null,
      cellRange: null,
      dragRange: null,
      selectedRows: new Set(),
      hoverRow: null,
      hoverCol: null,
      page: 0,
      pageSize: 100,
      hasCellEdit: false,
      enableValuePanelAffordance: false,
      relationHighlightColumnIds: new Set(),
      enableSort: false,
      sortColumn: null,
      sortDirection: null,
      canFilter: false,
      filterColumnNames: new Set(),
      autoIncrementPlaceholder: "(auto)",
      nullLabel: "NULL",
      emptyLabel: "EMPTY",
    });
    expect(broken.getCellModel(0, 1)?.kind).toBe("null");
  });

  it("dragColumnWidth overrides stale measured header geometry", () => {
    const { snapshot } = buildGridSnapshotBundle({
      leafColumns: [
        { id: "__row_num__", getSize: () => 40 },
        { id: "content", getSize: () => 200 },
        { id: "product", getSize: () => 160 },
      ],
      tableRows: [{ index: 0, original: { content: "a", product: "b" } }],
      resolveColumnWidth: (_id, size) => size,
      rowHeights: {},
      defaultRowHeight: 32,
      dragColumnWidth: { columnId: "content", width: 320 },
      measuredColumnGeometry: [
        { x: 0, width: 40 },
        { x: 40, width: 200 },
        { x: 240, width: 160 },
      ],
      measuredTotalWidth: 400,
      transposed: false,
      columnMetaMap: null,
      pkCols: [],
      displayCellOverrides: null,
      displayDirtyRowKeys: null,
      deletedRowKeys: null,
      cellRange: null,
      dragRange: null,
      selectedRows: new Set(),
      hoverRow: null,
      hoverCol: null,
      page: 0,
      pageSize: 100,
      hasCellEdit: false,
      enableValuePanelAffordance: false,
      relationHighlightColumnIds: new Set(),
      enableSort: false,
      sortColumn: null,
      sortDirection: null,
      canFilter: false,
      filterColumnNames: new Set(),
      autoIncrementPlaceholder: "(auto)",
      nullLabel: "NULL",
      emptyLabel: "EMPTY",
    });

    expect(snapshot.columns[1]?.width).toBe(320);
    expect(snapshot.columns[2]?.x).toBe(40 + 320);
    expect(snapshot.totalWidth).toBe(40 + 320 + 160);
  });

  it("dragColumnWidths freezes all columns and ignores measured geometry", () => {
    const { snapshot } = buildGridSnapshotBundle({
      leafColumns: [
        { id: "__row_num__", getSize: () => 40 },
        { id: "content", getSize: () => 200 },
        { id: "product", getSize: () => 160 },
      ],
      tableRows: [{ index: 0, original: { content: "a", product: "b" } }],
      resolveColumnWidth: (_id, size) => size,
      rowHeights: {},
      defaultRowHeight: 32,
      dragColumnWidths: {
        __row_num__: 40,
        content: 320,
        product: 160,
      },
      measuredColumnGeometry: [
        { x: 0, width: 40 },
        { x: 40, width: 500 },
        { x: 540, width: 200 },
      ],
      measuredTotalWidth: 740,
      transposed: false,
      columnMetaMap: null,
      pkCols: [],
      displayCellOverrides: null,
      displayDirtyRowKeys: null,
      deletedRowKeys: null,
      cellRange: null,
      dragRange: null,
      selectedRows: new Set(),
      hoverRow: null,
      hoverCol: null,
      page: 0,
      pageSize: 100,
      hasCellEdit: false,
      enableValuePanelAffordance: false,
      relationHighlightColumnIds: new Set(),
      enableSort: false,
      sortColumn: null,
      sortDirection: null,
      canFilter: false,
      filterColumnNames: new Set(),
      autoIncrementPlaceholder: "(auto)",
      nullLabel: "NULL",
      emptyLabel: "EMPTY",
    });

    expect(snapshot.columns[1]?.width).toBe(320);
    expect(snapshot.columns[2]?.width).toBe(160);
    expect(snapshot.columns[2]?.x).toBe(360);
    expect(snapshot.totalWidth).toBe(520);
  });
});
