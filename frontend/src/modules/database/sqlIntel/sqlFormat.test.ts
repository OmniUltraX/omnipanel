import { describe, expect, it } from "vitest";
import { findStatementRangeAtOffset } from "./sqlLex";
import { formatSqlRange, formatStatement } from "./sqlFormat";

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
