import { describe, expect, it } from "vitest";
import { findStatementRangeAtOffset, splitSqlStatements } from "./sqlLex";
import { formatSqlRange, formatStatement } from "./sqlFormat";

describe("splitSqlStatements", () => {
  it("漏写分号时，换行后的新 SELECT 单独成句", () => {
    const sql = "SELECT COUNT(*) FROM sys_role_menu WHERE menu_id = 1\n\nSELECT COUNT(*) FROM sys_role_menu WHERE menu_id = 1";
    const parts = splitSqlStatements(sql);
    expect(parts.map((part) => part.sql)).toEqual([
      "SELECT COUNT(*) FROM sys_role_menu WHERE menu_id = 1",
      "SELECT COUNT(*) FROM sys_role_menu WHERE menu_id = 1",
    ]);
    expect(parts.every((part) => !part.hadTrailingSemicolon)).toBe(true);
  });

  it("INSERT … SELECT 和 UNION 仍是一条", () => {
    expect(splitSqlStatements("INSERT INTO t (a, b)\nSELECT 1, 2\nWHERE NOT EXISTS (\n  SELECT 1\n)").map((part) => part.sql)).toHaveLength(1);
    expect(splitSqlStatements("SELECT 1 FROM t\nUNION ALL\nSELECT 2 FROM t").map((part) => part.sql)).toHaveLength(1);
    expect(splitSqlStatements("UPDATE t\nSET a = 1\nWHERE id = 1").map((part) => part.sql)).toHaveLength(1);
  });

  it("光标落在第二条时只框住这一条", () => {
    const sql = "SELECT 1 FROM t\nSELECT 2 FROM t";
    const at = sql.indexOf("SELECT 2");
    const range = findStatementRangeAtOffset(sql, at);
    expect(sql.slice(range.from, range.to)).toBe("SELECT 2 FROM t");
  });
});

describe("formatSqlRange", () => {
  it("保留当前语句前面的空行", () => {
    const doc = "SET @a = 1;\n\nINSERT INTO t (a, b) SELECT 1, 2;";
    const range = findStatementRangeAtOffset(doc, doc.indexOf("INSERT"));
    const { text } = formatSqlRange(doc, range.from, range.to, range.from, "mysql");
    expect(text.startsWith("SET @a = 1;\n\n")).toBe(true);
    expect(text.includes("1;INSERT")).toBe(false);
  });
});

describe("formatStatement compact", () => {
  it("关键字换行，字段留在同一行", () => {
    expect(
      formatStatement(
        "insert into t (a, b, c) select 1, 2, 3 from t where id = 1 and flag = 0",
        "mysql",
        "compact",
      ),
    ).toBe("INSERT INTO t (a, b, c)\nSELECT 1, 2, 3\nFROM t\nWHERE id = 1\n  AND flag = 0");
  });

  it("把拆开的字段合并回同一行", () => {
    expect(formatStatement("SELECT\n  a,\n  b,\n  c\nFROM t", "mysql", "compact")).toBe(
      "SELECT a, b, c\nFROM t",
    );
  });

  it("子查询括号缩进，结束括号单独对齐", () => {
    expect(
      formatStatement(
        "select 1 from t where not exists (select 1 from t where id = 1 and flag = 0)",
        "mysql",
        "compact",
      ),
    ).toBe(
      [
        "SELECT 1",
        "FROM t",
        "WHERE not exists (",
        "  SELECT 1",
        "  FROM t",
        "  WHERE id = 1 and flag = 0",
        ")",
      ].join("\n"),
    );
  });

  it("嵌套子查询按层级缩进", () => {
    expect(
      formatStatement(
        "select 1 from t where not exists (select 1 from u where not exists (select 1 from v))",
        "mysql",
        "compact",
      ),
    ).toBe(
      [
        "SELECT 1",
        "FROM t",
        "WHERE not exists (",
        "  SELECT 1",
        "  FROM u",
        "  WHERE not exists (",
        "    SELECT 1",
        "    FROM v",
        "  )",
        ")",
      ].join("\n"),
    );
  });
});
