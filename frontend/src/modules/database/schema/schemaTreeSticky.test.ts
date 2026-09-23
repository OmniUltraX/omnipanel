import { describe, expect, it } from "vitest";
import {
  collectViewportStickySchemaRows,
  SCHEMA_TREE_NODE_ROW_HEIGHT,
  type SchemaFlatRow,
} from "./schemaTreeFlatRows";

function row(
  key: string,
  depth: number,
  expanded: boolean,
  hasChildren: boolean,
): SchemaFlatRow {
  return {
    kind: "node",
    key,
    depth,
    expanded,
    hasChildren,
    item: { id: key },
  } as SchemaFlatRow;
}

const tree: SchemaFlatRow[] = [
  row("conn", 0, true, true),
  row("db", 1, true, true),
  row("tables", 2, true, true),
  row("t1", 3, false, false),
  row("t2", 3, false, false),
  row("views", 2, true, true),
];

describe("collectViewportStickySchemaRows", () => {
  it("未滚动时不吸顶", () => {
    expect(collectViewportStickySchemaRows(tree, 0)).toEqual([]);
  });

  it("滚进表列表时吸住连接、库和分组", () => {
    const stuck = collectViewportStickySchemaRows(tree, 1);
    expect(stuck.map((entry) => entry.row.key)).toEqual(["conn", "db", "tables"]);
  });

  it("下一分组越过吸顶线后替换同层分组", () => {
    const viewsOffset = 5 * SCHEMA_TREE_NODE_ROW_HEIGHT;
    const before = collectViewportStickySchemaRows(tree, viewsOffset - 2 * SCHEMA_TREE_NODE_ROW_HEIGHT);
    expect(before.map((entry) => entry.row.key)).toEqual(["conn", "db", "tables"]);

    const after = collectViewportStickySchemaRows(tree, viewsOffset - 2 * SCHEMA_TREE_NODE_ROW_HEIGHT + 1);
    expect(after.map((entry) => entry.row.key)).toEqual(["conn", "db", "views"]);
  });

  it("折叠节点不吸顶", () => {
    const collapsed = [row("conn", 0, false, true), row("db", 1, true, true)];
    expect(collectViewportStickySchemaRows(collapsed, 40).map((entry) => entry.row.key)).toEqual(["db"]);
  });
});
