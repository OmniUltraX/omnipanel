import { describe, expect, it } from "vitest";
import { buildApplySqlMySQL, hasModelChanges } from "./applySql";
import type { TableDesignerFieldRow, TableDesignerModel } from "./types";

function field(id: string, name: string): TableDesignerFieldRow {
  return {
    id,
    name,
    type: "VARCHAR",
    length: "64",
    nullable: true,
    isPk: false,
    isAutoIncrement: false,
    defaultValue: "",
    comment: "",
  };
}

function model(fields: TableDesignerFieldRow[]): TableDesignerModel {
  return { tableName: "t1", comment: "", fields, indexes: [] };
}

describe("hasModelChanges field order", () => {
  it("detects reorder without other changes", () => {
    const f1 = field("a", "col_a");
    const f2 = field("b", "col_b");
    const f3 = field("c", "col_c");
    const baseline = model([f1, f2, f3]);
    const reordered = model([f1, f3, f2]);
    expect(hasModelChanges(baseline, reordered)).toBe(true);
    expect(hasModelChanges(baseline, baseline)).toBe(false);
  });
});

describe("buildApplySqlMySQL column reorder", () => {
  it("emits MODIFY ... AFTER when columns are reordered", () => {
    const f1 = field("a", "col_a");
    const f2 = field("b", "col_b");
    const f3 = field("c", "col_c");
    const baseline = model([f1, f2, f3]);
    const reordered = model([f1, f3, f2]);
    const stmts = buildApplySqlMySQL(baseline, reordered, "db");
    expect(stmts).toEqual([
      "ALTER TABLE `db`.`t1` MODIFY COLUMN `col_c` VARCHAR(64) AFTER `col_a`",
    ]);
  });

  it("reorders newly added column inserted in the middle", () => {
    const f1 = field("a", "col_a");
    const f2 = field("b", "col_b");
    const f3 = field("c", "col_new");
    f3.name = "col_mid";
    const baseline = model([f1, f2]);
    const updated = model([f1, f3, f2]);
    const stmts = buildApplySqlMySQL(baseline, updated, "db");
    expect(stmts[0]).toContain("ADD COLUMN `col_mid`");
    expect(stmts).toContain(
      "ALTER TABLE `db`.`t1` MODIFY COLUMN `col_mid` VARCHAR(64) AFTER `col_a`",
    );
  });
});
