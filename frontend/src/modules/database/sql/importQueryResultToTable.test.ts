import { describe, expect, it } from "vitest";
import type { DbColumnMeta } from "../api";
import {
  buildClearTableSql,
  listConstantFillTargetColumns,
  matchColumnsByName,
  parseImportConstantValue,
} from "./importQueryResultToTable";

describe("matchColumnsByName", () => {
  it("matches by case-insensitive name and keeps target casing", () => {
    const result = matchColumnsByName(
      ["id", "Tenant_Id", "extra"],
      ["ID", "tenant_id", "name"],
    );
    expect(result.matched).toEqual([
      { source: "id", target: "ID" },
      { source: "Tenant_Id", target: "tenant_id" },
    ]);
    expect(result.sourceOnly).toEqual(["extra"]);
    expect(result.targetOnly).toEqual(["name"]);
  });

  it("returns empty matched when no overlap", () => {
    const result = matchColumnsByName(["a"], ["b"]);
    expect(result.matched).toEqual([]);
    expect(result.sourceOnly).toEqual(["a"]);
    expect(result.targetOnly).toEqual(["b"]);
  });
});

describe("buildClearTableSql", () => {
  it("uses DELETE for sqlite", () => {
    expect(buildClearTableSql("sqlite", "t")).toBe("DELETE FROM `t`");
  });

  it("uses TRUNCATE for mysql", () => {
    expect(buildClearTableSql("mysql", "t")).toBe("TRUNCATE TABLE `t`");
  });
});

describe("listConstantFillTargetColumns", () => {
  const meta: DbColumnMeta[] = [
    { name: "id", type: "int", isPk: true, isFk: false, nullable: false, isAutoIncrement: true },
    { name: "title", type: "varchar", isPk: false, isFk: false, nullable: false },
    { name: "note", type: "text", isPk: false, isFk: false, nullable: true },
  ];

  it("returns only not-null unmatched non-auto columns", () => {
    const match = matchColumnsByName(["a"], ["id", "title", "note"]);
    expect(listConstantFillTargetColumns(match, meta).map((c) => c.name)).toEqual(["title"]);
  });
});

describe("parseImportConstantValue", () => {
  it("parses numeric and quoted string values", () => {
    expect(parseImportConstantValue("42", { name: "n", type: "int", isPk: false, isFk: false })).toBe(42);
    expect(parseImportConstantValue("'hello'", { name: "s", type: "varchar", isPk: false, isFk: false })).toBe(
      "hello",
    );
  });

  it("returns undefined for empty input", () => {
    expect(parseImportConstantValue("  ", undefined)).toBeUndefined();
  });
});
