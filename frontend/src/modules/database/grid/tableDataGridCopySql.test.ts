import { describe, expect, it } from "vitest";
import { buildInsertSql, formatSqlLiteral } from "./tableDataGridCopySql";

describe("formatSqlLiteral mysql", () => {
  it("用 '' 转义单引号，避免 \\' 被语句拆分提前截断", () => {
    expect(formatSqlLiteral("a'b", "mysql")).toBe("'a''b'");
    expect(formatSqlLiteral("a\\b", "mysql")).toBe("'a\\\\b'");
  });

  it("兼容含 MyBatis/JDBC 异常文本的字面量", () => {
    const msg =
      "### Error updating database.  Cause: com.mysql.cj.jdbc.exceptions.MysqlDataTruncation: Data truncation: Data too long for column 'name' at row 1";
    const lit = formatSqlLiteral(msg, "mysql");
    expect(lit.startsWith("'")).toBe(true);
    expect(lit.endsWith("'")).toBe(true);
    expect(lit).toContain("''name''");
    expect(lit).not.toMatch(/\\'/);
  });
});

describe("buildInsertSql mysql", () => {
  it("合并 VALUES 时保留串内分号与引号", () => {
    const sql = buildInsertSql({
      dbType: "mysql",
      tableName: "logs",
      columns: ["msg"],
      rows: [
        {
          msg: "### Error updating database. Cause: 'MysqlDataTruncation'; detail; more",
        },
      ],
      mode: "merged",
    });
    expect(sql).toContain("''MysqlDataTruncation''");
    expect(sql).toContain("detail; more");
    expect(sql.endsWith(";")).toBe(true);
    // 串内分号不应导致 VALUES 被截断：整句只有一条 INSERT
    expect(sql.trimStart().startsWith("INSERT INTO")).toBe(true);
    expect(sql.indexOf("INSERT INTO")).toBe(sql.lastIndexOf("INSERT INTO"));
  });
});
