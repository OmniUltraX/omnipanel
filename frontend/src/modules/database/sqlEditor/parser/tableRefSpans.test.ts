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

const eduSchemas: DatabaseSchema[] = [
  {
    name: "edu",
    tables: [
      { name: "edu_book", columns: [{ name: "id", type: "int", isPK: true }] },
      { name: "edu_book_version", columns: [{ name: "id", type: "int", isPK: true }] },
      { name: "edu_english_unit", columns: [{ name: "id", type: "int", isPK: true }] },
      { name: "edu_english_word", columns: [{ name: "id", type: "int", isPK: true }] },
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
    const catalog = Catalog.fromSchemas(schemas);
    const spans = extractTableRefSpans(sql, 0, "mysql", catalog);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.schemaName).toBe("app");
    expect(spans[0]?.tableName).toBe("missing_table");
    expect(sql.slice(spans[0]!.from, spans[0]!.to)).toBe("missing_table");
  });

  it("ignores alias.column when JOIN appears inside nested subquery", () => {
    const catalog = Catalog.fromSchemas(eduSchemas);
    const sql = `
SELECT eb.id
FROM edu_book eb
LEFT JOIN (
  SELECT eeu.id, count(eew.id) AS u_count
  FROM edu_english_unit eeu
  LEFT JOIN edu_english_word eew ON eeu.id = eew.unit_id
  GROUP BY eeu.id
) t1 ON eb.id = t1.textbook_grade_id
`.trim();
    const spans = extractTableRefSpans(sql, 0, "mysql", catalog);
    const names = spans.map((span) =>
      span.schemaName ? `${span.schemaName}.${span.tableName}` : span.tableName,
    );
    expect(names).not.toContain("eb.id");
    expect(names).not.toContain("eeu.id");
    expect(names).toEqual(["edu_book"]);
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
