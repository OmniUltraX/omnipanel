import { describe, expect, it } from "vitest";
import {
  formatMysqlAddColumnPositionClause,
  resolveMysqlAddColumnPosition,
} from "./schemaSyncAddColumnPosition";

describe("resolveMysqlAddColumnPosition", () => {
  const source = [
    { name: "id" },
    { name: "update_time" },
    { name: "chapter_json" },
    { name: "name" },
  ];

  it("places new mid column AFTER previous existing column", () => {
    const existing = new Set(["id", "update_time", "name"]);
    expect(resolveMysqlAddColumnPosition(source, "chapter_json", existing)).toEqual({
      kind: "after",
      columnName: "update_time",
    });
  });

  it("uses FIRST when no previous column exists on target", () => {
    const existing = new Set(["update_time", "name"]);
    expect(resolveMysqlAddColumnPosition(source, "id", existing)).toEqual({
      kind: "first",
    });
  });

  it("chains AFTER newly added columns in the same batch", () => {
    const existing = new Set(["id", "name"]);
    expect(resolveMysqlAddColumnPosition(source, "update_time", existing)).toEqual({
      kind: "after",
      columnName: "id",
    });
    existing.add("update_time");
    expect(resolveMysqlAddColumnPosition(source, "chapter_json", existing)).toEqual({
      kind: "after",
      columnName: "update_time",
    });
  });
});

describe("formatMysqlAddColumnPositionClause", () => {
  const quote = (name: string) => `\`${name}\``;

  it("formats FIRST and AFTER", () => {
    expect(formatMysqlAddColumnPositionClause({ kind: "first" }, quote)).toBe(" FIRST");
    expect(
      formatMysqlAddColumnPositionClause({ kind: "after", columnName: "update_time" }, quote),
    ).toBe(" AFTER `update_time`");
    expect(formatMysqlAddColumnPositionClause({ kind: "none" }, quote)).toBe("");
  });
});
