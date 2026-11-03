import { describe, expect, it } from "vitest";
import { resolveSchemaSearchContextIds } from "./schemaTreeSidebarLinkage";
import {
  computeSchemaRowsScrollTopForStart,
  SCHEMA_TREE_NODE_ROW_HEIGHT,
  type SchemaFlatRow,
} from "./schemaTreeFlatRows";

function row(key: string, depth = 0, sticky = true): SchemaFlatRow {
  return {
    kind: "node",
    key,
    depth,
    expanded: sticky,
    hasChildren: sticky,
    item: { id: key },
  } as SchemaFlatRow;
}

describe("resolveSchemaSearchContextIds", () => {
  it("当前在表上时同时带上连接、库和这张表", () => {
    expect(
      resolveSchemaSearchContextIds({
        activeTableKey: "tbl:c1:mkdeptdvs_bak:policy_confirm_item",
        activeDatabaseKey: "db:c1:mkdeptdvs_bak",
        activeConnId: "c1",
      }),
    ).toEqual([
      "conn:c1",
      "db:c1:mkdeptdvs_bak",
      "tbl:c1:mkdeptdvs_bak:policy_confirm_item",
    ]);
  });

  it("当前在库上时带上连接和该库", () => {
    expect(
      resolveSchemaSearchContextIds({
        activeTableKey: null,
        activeDatabaseKey: "db:c1:mkdeptdvs_bak",
        activeConnId: "c1",
      }),
    ).toEqual(["conn:c1", "db:c1:mkdeptdvs_bak"]);
  });
});

describe("computeSchemaRowsScrollTopForStart", () => {
  const rows = [row("other"), row("conn"), row("db"), row("t1"), row("t2")];

  it("把当前连接贴到视口顶部，而不是整块居中", () => {
    const top = computeSchemaRowsScrollTopForStart(rows, [1, 2]);
    expect(top).toBe(SCHEMA_TREE_NODE_ROW_HEIGHT);
  });

  it("当前库前面还有别的库时，连接吸顶、库贴在连接下面", () => {
    const withGap = [row("other"), row("conn"), row("other-db"), row("db"), row("t1")];
    const top = computeSchemaRowsScrollTopForStart(withGap, [1, 3]);
    expect(top).toBe(SCHEMA_TREE_NODE_ROW_HEIGHT * 2);
  });

  it("当前表抬到连接和库的吸顶头下面，而不是停在同级结果中间", () => {
    const rows = [
      row("conn", 0, true),
      row("db", 1, true),
      row("before", 2, false),
      row("current", 2, false),
      row("after", 2, false),
    ];
    const top = computeSchemaRowsScrollTopForStart(rows, [0, 1, 3]);
    expect(top).toBe(SCHEMA_TREE_NODE_ROW_HEIGHT);
  });
});
