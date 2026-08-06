import { describe, expect, it } from "vitest";
import { Catalog } from "../catalog";
import { analyzeStatement } from "../parser/analyzer";
import { classifySemanticIdentifier } from "./semantic";
import type { DatabaseSchema } from "../../types";

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

describe("classifySemanticIdentifier", () => {
  const catalog = Catalog.fromSchemas(schemas);

  it("classifies table, alias, and column in a simple SELECT", () => {
    const sql = "SELECT u.id, u.name FROM users u WHERE u.id = 1";
    const analysis = analyzeStatement(sql, "mysql");

    expect(classifySemanticIdentifier(catalog, analysis, "users", null)).toBe("table");
    expect(classifySemanticIdentifier(catalog, analysis, "u", null)).toBe("alias");
    expect(classifySemanticIdentifier(catalog, analysis, "id", "u")).toBe("column");
    expect(classifySemanticIdentifier(catalog, analysis, "name", "u")).toBe("column");
  });

  it("classifies database and table in qualified names", () => {
    const sql = "SELECT * FROM mydb.users";
    const analysis = analyzeStatement(sql, "mysql");

    expect(classifySemanticIdentifier(catalog, analysis, "mydb", null)).toBe("database");
    expect(classifySemanticIdentifier(catalog, analysis, "users", "mydb")).toBe("table");
  });

  it("ignores SQL keywords", () => {
    expect(classifySemanticIdentifier(catalog, null, "SELECT", null)).toBeNull();
    expect(classifySemanticIdentifier(catalog, null, "FROM", null)).toBeNull();
  });
});
