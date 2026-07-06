import { describe, expect, it } from "vitest";
import { Catalog } from "../catalog";
import { extractTableRefSpans, resolveMissingTableHover, analyzeStatement } from "./analyzer";
import type { DatabaseSchema } from "../../types";

const schemas: DatabaseSchema[] = [
  {
    name: "app",
    tables: [
      {
        name: "users",
        columns: [{ name: "id", type: "int", isPK: true }],
      },
    ],
  },
];

describe("extractTableRefSpans", () => {
  it("marks missing table token in FROM clause", () => {
    const sql = "SELECT * FROM ghost_users";
    const spans = extractTableRefSpans(sql, 0, "mysql");
    expect(spans).toHaveLength(1);
    expect(spans[0]?.tableName).toBe("ghost_users");
    expect(sql.slice(spans[0]!.from, spans[0]!.to)).toBe("ghost_users");
  });

  it("marks qualified missing table", () => {
    const sql = "SELECT * FROM app.missing_table";
    const spans = extractTableRefSpans(sql, 0, "mysql");
    expect(spans).toHaveLength(1);
    expect(spans[0]?.schemaName).toBe("app");
    expect(spans[0]?.tableName).toBe("missing_table");
    expect(sql.slice(spans[0]!.from, spans[0]!.to)).toBe("missing_table");
  });
});

describe("resolveMissingTableHover", () => {
  const catalog = Catalog.fromSchemas(schemas);

  it("detects missing bare table name", () => {
    const sql = "SELECT * FROM ghost_users";
    const analysis = analyzeStatement(sql, "mysql");
    const missing = resolveMissingTableHover(catalog, analysis, "ghost_users", null);
    expect(missing).toBe("ghost_users");
  });

  it("detects missing qualified table", () => {
    const missing = resolveMissingTableHover(catalog, null, "missing_table", "app");
    expect(missing).toBe("app.missing_table");
  });

  it("ignores existing table", () => {
    const sql = "SELECT * FROM users";
    const analysis = analyzeStatement(sql, "mysql");
    const missing = resolveMissingTableHover(catalog, analysis, "users", null);
    expect(missing).toBeNull();
  });
});
