import { describe, expect, it } from "vitest";

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
});
