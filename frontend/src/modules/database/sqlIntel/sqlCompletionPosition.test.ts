import { describe, expect, it } from "vitest";
import {
  currentSqlWordPrefix,
  isCursorInSqlString,
  resolveCompletionIntent,
} from "./sqlCompletionPosition";
import { resolveSqlCompletionContext } from "../sqlEditor/parser/context";

describe("sqlCompletionPosition", () => {
  it("detects cursor inside single-quoted string", () => {
    const sql = "WHERE book_type = 'textbook'";
    const quoteStart = sql.indexOf("'") + 1;
    const inside = sql.indexOf("textbook") + 3;
    expect(isCursorInSqlString(sql, quoteStart)).toBe(true);
    expect(isCursorInSqlString(sql, inside)).toBe(true);
    expect(isCursorInSqlString(sql, sql.length)).toBe(false);
  });

  it("does not treat string literal as word prefix", () => {
    const sql = "WHERE book_type = 'textbook'";
    const inside = sql.indexOf("textbook") + 5;
    expect(currentSqlWordPrefix(sql, inside)).toBe("");
  });

  it("resolves values intent after equals", () => {
    const sql = "UPDATE users SET name = ";
    const context = resolveSqlCompletionContext(sql, sql.length);
    expect(resolveCompletionIntent(sql, sql.length, context)).toBe("values");
  });

  it("resolves columns intent after OR in WHERE", () => {
    const sql =
      "update tiku_textbook set book_type = '考轻松' where book_type = '用户自定义' or ";
    const context = resolveSqlCompletionContext(sql, sql.length);
    expect(context).toBe("where_clause");
    expect(resolveCompletionIntent(sql, sql.length, context)).toBe("columns");
  });

  it("resolves columns intent after WHERE", () => {
    const sql = "UPDATE users SET name = 'a' WHERE ";
    const context = resolveSqlCompletionContext(sql, sql.length);
    expect(resolveCompletionIntent(sql, sql.length, context)).toBe("columns");
  });
});
