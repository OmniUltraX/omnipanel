import { describe, expect, it } from "vitest";
import { resolveDerivedColumnInStatement } from "./derivedColumns";

describe("resolveDerivedColumnInStatement", () => {
  it("resolves subquery alias column definition", () => {
    const sql = `
      SELECT t3.template
      FROM (
        SELECT
          CASE WHEN grade > 9 THEN '高中.json' ELSE 'other.json' END AS template
        FROM foo
      ) t3
    `;
    const derived = resolveDerivedColumnInStatement(sql, "t3", "template", "mysql");
    expect(derived).not.toBeNull();
    expect(derived?.name).toBe("template");
    expect(derived?.expression).toContain("CASE WHEN");
    expect(derived?.expression).toContain("高中.json");
  });

  it("does not match unrelated alias", () => {
    const sql = `SELECT t3.template FROM (SELECT 1 AS template FROM foo) t3`;
    expect(resolveDerivedColumnInStatement(sql, "t2", "template", "mysql")).toBeNull();
  });
});
