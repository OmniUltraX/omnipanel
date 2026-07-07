import { describe, expect, it } from "vitest";
import { resolveSqlCompletionContext } from "./context";

describe("resolveSqlCompletionContext", () => {
  it("returns group_by after GROUP BY without WHERE", () => {
    const sql = "SELECT * FROM tiku_textbook GROUP BY ";
    expect(resolveSqlCompletionContext(sql, sql.length)).toBe("group_by");
  });

  it("returns where_clause when WHERE is the latest clause", () => {
    const sql = "SELECT * FROM t WHERE status = ";
    expect(resolveSqlCompletionContext(sql, sql.length)).toBe("where_clause");
  });

  it("returns group_by when GROUP BY follows WHERE", () => {
    const sql = "SELECT * FROM t WHERE active = 1 GROUP BY ";
    expect(resolveSqlCompletionContext(sql, sql.length)).toBe("group_by");
  });

  it("returns from_clause between FROM and next clause", () => {
    const sql = "SELECT * FROM ";
    expect(resolveSqlCompletionContext(sql, sql.length)).toBe("from_clause");
  });

  it("returns order_by after ORDER BY", () => {
    const sql = "SELECT * FROM t ORDER BY ";
    expect(resolveSqlCompletionContext(sql, sql.length)).toBe("order_by");
  });

  it("returns update_table after UPDATE", () => {
    const sql = "UPDATE ";
    expect(resolveSqlCompletionContext(sql, sql.length)).toBe("update_table");
  });

  it("returns update_set after UPDATE table SET", () => {
    const sql = "UPDATE users SET ";
    expect(resolveSqlCompletionContext(sql, sql.length)).toBe("update_set");
  });

  it("returns where_clause after UPDATE table SET assignments WHERE", () => {
    const sql = "UPDATE users SET name = 'a' WHERE ";
    expect(resolveSqlCompletionContext(sql, sql.length)).toBe("where_clause");
  });
});
