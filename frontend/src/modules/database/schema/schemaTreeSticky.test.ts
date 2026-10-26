import { describe, expect, it } from "vitest";
import {
  collectViewportStickySchemaRows,
  computeSchemaFlatRowScrollTopForNearest,
  isSchemaFlatRowIndexInViewport,
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

describe("滚入视口时避开吸顶层", () => {
  const H = SCHEMA_TREE_NODE_ROW_HEIGHT;
  const rows: SchemaFlatRow[] = [
    row("conn", 0, true, true),
    row("db", 1, true, true),
    row("tables", 2, true, true),
    ...Array.from({ length: 30 }, (_, index) => row(`t${index}`, 3, false, false)),
  ];
  const target = 3 + 17;
  const targetOffset = target * H;

  function viewport(scrollTop: number, clientHeight: number): HTMLElement {
    return { scrollTop, clientHeight } as HTMLElement;
  }

  it("从下方切到上方节点时，把目标留在连接、库、分组下面", () => {
    const next = computeSchemaFlatRowScrollTopForNearest(rows, target, 10 * H, 24 * H);
    expect(next).toBe(targetOffset - 3 * H);
    expect(collectViewportStickySchemaRows(rows, next).map((entry) => entry.row.key)).toEqual([
      "conn",
      "db",
      "tables",
    ]);
    expect(isSchemaFlatRowIndexInViewport(viewport(next, 10 * H), rows, target)).toBe(true);
  });

  it("目标贴在视口顶上、被吸顶挡住时不算可见", () => {
    expect(isSchemaFlatRowIndexInViewport(viewport(targetOffset, 12 * H), rows, target)).toBe(false);
  });

  it("目标已经在吸顶层下方时不再滚动", () => {
    const scrollTop = targetOffset - 6 * H;
    expect(computeSchemaFlatRowScrollTopForNearest(rows, target, 12 * H, scrollTop)).toBe(scrollTop);
  });

  it("目标在视口下方时只滚到下沿", () => {
    const viewportHeight = 10 * H;
    expect(computeSchemaFlatRowScrollTopForNearest(rows, target, viewportHeight, 0)).toBe(
      targetOffset + H - viewportHeight,
    );
  });
});
