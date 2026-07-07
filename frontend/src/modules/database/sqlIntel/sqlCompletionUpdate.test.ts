import { describe, expect, it } from "vitest";
import { getCompletionItems } from "../sqlEditor/language/completionItems";
import { buildDatabaseSchema, introspectToTableSchemas } from "../sqlEditor/language/completionItems";

const schemas = [
  buildDatabaseSchema(
    "demo",
    introspectToTableSchemas([
      {
        name: "users",
        columns: [
          { name: "id", type: "int" },
          { name: "name", type: "varchar" },
          { name: "email", type: "varchar" },
        ],
      },
    ]),
  ),
];

const tikuTextbookSchemas = [
  buildDatabaseSchema(
    "demo",
    introspectToTableSchemas([
      {
        name: "tiku_textbook",
        columns: [
          { name: "id", type: "int" },
          { name: "book_name", type: "varchar" },
          { name: "book_code", type: "varchar" },
          { name: "book_type", type: "varchar" },
          { name: "title", type: "varchar" },
          { name: "status", type: "tinyint" },
        ],
      },
    ]),
  ),
];

const COLUMN_KIND = 5;
const FUNCTION_KIND = 3;
const KEYWORD_KIND = 14;

describe("getCompletionItems UPDATE", () => {
  it("offers table names after UPDATE", () => {
    const sql = "UPDATE ";
    const items = getCompletionItems(sql, sql.length, schemas);
    expect(items.some((item) => item.label === "users" && item.kind === 22)).toBe(true);
  });

  it("offers column names after UPDATE table SET", () => {
    const sql = "UPDATE users SET ";
    const items = getCompletionItems(sql, sql.length, schemas);
    const columnLabels = items.filter((item) => item.kind === 5).map((item) => item.label);
    expect(columnLabels).toEqual(expect.arrayContaining(["id", "name", "email"]));
  });

  it("offers column names after UPDATE table SET ... WHERE", () => {
    const sql = "UPDATE users SET name = 'a' WHERE ";
    const items = getCompletionItems(sql, sql.length, schemas);
    const columnLabels = items.filter((item) => item.kind === 5).map((item) => item.label);
    expect(columnLabels).toEqual(expect.arrayContaining(["id", "name", "email"]));
  });

  it("keeps all scoped table columns when typing a prefix in UPDATE SET", () => {
    const sql = "UPDATE tiku_textbook SET b";
    const items = getCompletionItems(sql, sql.length, tikuTextbookSchemas);
    const columnLabels = items.filter((item) => item.kind === COLUMN_KIND).map((item) => item.label);
    expect(columnLabels).toEqual(
      expect.arrayContaining(["id", "book_name", "book_code", "book_type", "title", "status"]),
    );
  });

  it("offers columns and AND/OR after OR in complex UPDATE WHERE", () => {
    const sql =
      "update tiku_textbook set book_type = '考轻松' where book_type = '用户自定义' or ";
    const items = getCompletionItems(sql, sql.length, tikuTextbookSchemas);
    const columnLabels = items.filter((item) => item.kind === COLUMN_KIND).map((item) => item.label);
    const keywordLabels = items.filter((item) => item.kind === KEYWORD_KIND).map((item) => item.label);
    expect(columnLabels).toEqual(expect.arrayContaining(["book_type", "book_name", "id"]));
    expect(keywordLabels).toEqual(expect.arrayContaining(["AND", "OR"]));
  });

  it("offers functions not columns after SET column equals", () => {
    const sql = "UPDATE tiku_textbook SET book_type = ";
    const items = getCompletionItems(sql, sql.length, tikuTextbookSchemas, "mysql");
    const columnLabels = items.filter((item) => item.kind === COLUMN_KIND).map((item) => item.label);
    const functionLabels = items.filter((item) => item.kind === FUNCTION_KIND).map((item) => item.label);
    expect(columnLabels).toHaveLength(0);
    expect(functionLabels.length).toBeGreaterThan(0);
  });

  it("offers functions not columns after WHERE column equals", () => {
    const sql = "UPDATE tiku_textbook SET book_type = 'a' WHERE book_type = ";
    const items = getCompletionItems(sql, sql.length, tikuTextbookSchemas, "mysql");
    const columnLabels = items.filter((item) => item.kind === COLUMN_KIND).map((item) => item.label);
    const functionLabels = items.filter((item) => item.kind === FUNCTION_KIND).map((item) => item.label);
    expect(columnLabels).toHaveLength(0);
    expect(functionLabels.length).toBeGreaterThan(0);
  });

  it("returns no completions inside string literal", () => {
    const sql = "UPDATE tiku_textbook SET book_type = 'textbook'";
    const inside = sql.lastIndexOf("'textbook'") + 4;
    expect(getCompletionItems(sql, inside, tikuTextbookSchemas)).toHaveLength(0);
  });
});

describe("getCompletionItems FROM table tail", () => {
  it("offers suggested alias and clause keywords after FROM table + space", () => {
    const sql = "select * from tiku_textbook ";
    const items = getCompletionItems(sql, sql.length, tikuTextbookSchemas);
    const labels = items.map((item) => item.label);
    expect(labels).toContain("tt");
    expect(labels).toEqual(
      expect.arrayContaining(["WHERE", "LIMIT", "GROUP BY", "ORDER BY"]),
    );
    expect(items.some((item) => item.kind === 22 && item.label === "tiku_textbook")).toBe(false);
    expect(items[0]?.label).toBe("tt");
  });
});

describe("getCompletionItems statement_start", () => {
  it("offers keywords not tables on an empty line", () => {
    const sql = "";
    const items = getCompletionItems(sql, 0, tikuTextbookSchemas);
    const keywordLabels = items.filter((item) => item.kind === KEYWORD_KIND).map((item) => item.label);
    const tableLabels = items.filter((item) => item.kind === 22).map((item) => item.label);
    expect(keywordLabels).toEqual(expect.arrayContaining(["SELECT", "UPDATE", "INSERT INTO"]));
    expect(tableLabels).toHaveLength(0);
    expect(items[0]?.kind).toBe(KEYWORD_KIND);
  });
});
