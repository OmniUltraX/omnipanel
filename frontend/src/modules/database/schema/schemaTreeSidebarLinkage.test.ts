import { describe, expect, it } from "vitest";
import { resolveSchemaSearchContextIds } from "./schemaTreeSidebarLinkage";
import {
  computeSchemaRowsScrollTopForCenter,
  SCHEMA_TREE_NODE_ROW_HEIGHT,
  type SchemaFlatRow,
} from "./schemaTreeFlatRows";

function row(key: string): SchemaFlatRow {
  return {
    kind: "node",
    key,
    depth: 0,
    expanded: true,
    hasChildren: true,
    item: { id: key },
  } as SchemaFlatRow;
}

describe("resolveSchemaSearchContextIds", () => {
  it("当前在表上时同时带上连接和库", () => {
    expect(
      resolveSchemaSearchContextIds({
        activeTableKey: "tbl:c1:mkdeptdvs_bak:policy_confirm_item",
        activeDatabaseKey: "db:c1:mkdeptdvs_bak",
        activeConnId: "c1",
      }),
    ).toEqual(["conn:c1", "db:c1:mkdeptdvs_bak"]);
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

describe("computeSchemaRowsScrollTopForCenter", () => {
  const rows = [row("conn"), row("db"), row("t1"), row("t2"), row("t3")];

  it("把连接和库的整体中点放到视口中间", () => {
    const viewport = SCHEMA_TREE_NODE_ROW_HEIGHT * 5;
    const top = computeSchemaRowsScrollTopForCenter(rows, [0, 1], viewport);
    const blockMid = SCHEMA_TREE_NODE_ROW_HEIGHT;
    expect(top).toBe(blockMid - viewport / 2);
  });
});
