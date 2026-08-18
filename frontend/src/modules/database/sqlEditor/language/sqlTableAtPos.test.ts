import { describe, expect, it } from "vitest";
import type { DatabaseSchema } from "../../types";
import { resolveSqlTableAtPos } from "./sqlTableAtPos";

const schemas: DatabaseSchema[] = [
  {
    name: "mydb",
    tables: [
      {
        name: "users",
        columns: [
          { name: "id", type: "int", isPK: true, nullable: false },
          { name: "name", type: "varchar", nullable: true },
        ],
      },
      {
        name: "orders",
        columns: [{ name: "user_id", type: "int", nullable: false }],
      },
    ],
  },
];

function posOf(doc: string, needle: string, offset = 0): number {
  const index = doc.indexOf(needle);
  expect(index).toBeGreaterThanOrEqual(0);
  return index + offset;
}

describe("resolveSqlTableAtPos", () => {
  it("resolves a FROM table name", () => {
    const doc = "SELECT id FROM users WHERE id = 1";
    const hit = resolveSqlTableAtPos(doc, posOf(doc, "users") + 1, schemas, "mysql");
    expect(hit).toEqual({
      from: posOf(doc, "users"),
      to: posOf(doc, "users") + "users".length,
      databaseName: "mydb",
      tableName: "users",
    });
  });

  it("resolves a table alias to the real table", () => {
    const doc = "SELECT * FROM users u";
    const hit = resolveSqlTableAtPos(doc, doc.length - 1, schemas, "mysql");
    expect(hit?.tableName).toBe("users");
    expect(hit?.databaseName).toBe("mydb");
  });

  it("resolves qualified db.table", () => {
    const doc = "SELECT * FROM mydb.users";
    const hit = resolveSqlTableAtPos(doc, posOf(doc, "users") + 1, schemas, "mysql");
    expect(hit?.tableName).toBe("users");
    expect(hit?.databaseName).toBe("mydb");
  });

  it("does not treat a column as a table", () => {
    const doc = "SELECT id FROM users";
    expect(resolveSqlTableAtPos(doc, posOf(doc, "id") + 1, schemas, "mysql")).toBeNull();
  });

  it("ignores identifiers in line comments", () => {
    const doc = "SELECT 1 -- users";
    expect(resolveSqlTableAtPos(doc, posOf(doc, "users") + 1, schemas, "mysql")).toBeNull();
  });
});
