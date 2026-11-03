import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "./sqlLex";
import {
  assignStatementTargets,
  rebindSavedStatementTargets,
  resolveSqlExecUnits,
  persistStatementTargets,
  statementIndexAt,
  statementVisualEnd,
  type SavedSqlStatementTarget,
} from "./sqlStatementTargets";

const crm: SavedSqlStatementTarget = {
  fingerprint: "select * from orders",
  targets: [
    { connId: "c1", database: "crm" },
    { connId: "c2", database: "orders" },
  ],
};

describe("sqlStatementTargets", () => {
  it("同一句出现两次时按顺序对上不同的库", () => {
    const assigned = assignStatementTargets(
      [{ sql: "SELECT * FROM orders" }, { sql: "SELECT * FROM orders" }],
      [
        { fingerprint: "select * from orders", targets: [{ connId: "c1", database: "crm" }] },
        { fingerprint: "select * from orders", targets: [{ connId: "c2", database: "archive" }] },
      ],
    );
    expect(assigned[0]).toEqual([{ connId: "c1", database: "crm" }]);
    expect(assigned[1]).toEqual([{ connId: "c2", database: "archive" }]);
  });

  it("正文对不上时退回文件默认库", () => {
    const assigned = assignStatementTargets([{ sql: "SELECT * FROM users" }], [crm]);
    expect(assigned).toEqual([[]]);
  });

  it("格式化后的空白和分号仍能对上", () => {
    const rebound = rebindSavedStatementTargets("SELECT   *\nFROM orders;", [crm]);
    expect(rebound).toEqual([
      {
        fingerprint: "select * from orders",
        targets: crm.targets,
      },
    ]);
  });

  it("整脚本按语句展开，改过的库各跑一次", () => {
    const units = resolveSqlExecUnits(
      "SELECT 1;\nSELECT * FROM orders;",
      undefined,
      undefined,
      [crm],
    );
    expect(units).toEqual([
      { sql: "SELECT 1", target: null },
      { sql: "SELECT * FROM orders", target: { connId: "c1", database: "crm" } },
      { sql: "SELECT * FROM orders", target: { connId: "c2", database: "orders" } },
    ]);
  });

  it("执行第二条相同语句时用它自己的库", () => {
    const sql = "SELECT * FROM orders;\nSELECT * FROM orders;";
    const saved: SavedSqlStatementTarget[] = [
      { fingerprint: "select * from orders", targets: [{ connId: "c1", database: "crm" }] },
      { fingerprint: "select * from orders", targets: [{ connId: "c2", database: "archive" }] },
    ];
    const index = statementIndexAt(sql, sql.lastIndexOf("SELECT"));
    const units = resolveSqlExecUnits(sql, "SELECT * FROM orders", index, saved);
    expect(units).toEqual([
      { sql: "SELECT * FROM orders", target: { connId: "c2", database: "archive" } },
    ]);
  });

  it("分号单独占一行时收进高亮，后面的空行不收", () => {
    const sql = "SELECT *\nFROM `sys_menu`\n;\n\nSELECT 2;";
    const parts = splitSqlStatements(sql);
    const end = statementVisualEnd(sql, parts[0]!.from, parts[0]!.to, parts[1]!.from);
    expect(sql.slice(end - 1, end)).toBe(";");
    expect(end).toBe(sql.indexOf(";") + 1);
  });

  it("分号后的空行不算进高亮，光标在空行里仍算前一条", () => {
    const sql = "SELECT 1;\n\n\nSELECT 2;";
    const first = sql.indexOf("SELECT 1");
    const semi = sql.indexOf(";");
    expect(statementVisualEnd(sql, first, semi, sql.length)).toBe(semi + 1);
    expect(statementVisualEnd(sql, first, sql.indexOf("SELECT 2"), sql.length)).toBe(semi + 1);
    const blank = sql.indexOf("\n\n") + 1;
    expect(statementIndexAt(sql, blank)).toBe(0);
    expect(statementIndexAt(sql, sql.lastIndexOf("SELECT"))).toBe(1);
  });

  it("只改回文件当前库时不保留覆盖", () => {
    const file = { connId: "c1", database: "crm" };
    expect(persistStatementTargets([file], file)).toEqual([]);
    expect(persistStatementTargets([{ connId: "c1", database: "CRM" }], file)).toEqual([]);
    expect(
      persistStatementTargets(
        [file, { connId: "c2", database: "archive" }],
        file,
      ),
    ).toEqual([file, { connId: "c2", database: "archive" }]);
    expect(persistStatementTargets([{ connId: "c2", database: "archive" }], file)).toEqual([
      { connId: "c2", database: "archive" },
    ]);
  });

  it("选中半句时不套用整句的执行库", () => {
    const units = resolveSqlExecUnits(
      "SELECT * FROM orders",
      "SELECT *",
      0,
      [crm],
    );
    expect(units).toEqual([{ sql: "SELECT *", target: null }]);
  });

  it("子查询单独执行时用自己的库，整句执行仍走语句上的库", () => {
    const sql = "SELECT * FROM menu m LEFT JOIN (\n  SELECT * FROM ca_school\n) t ON 1 = 1;";
    const anchor = sql.indexOf("SELECT * FROM ca_school");
    const saved: SavedSqlStatementTarget[] = [
      {
        fingerprint: "select * from menu m left join ( select * from ca_school ) t on 1 = 1",
        targets: [{ connId: "c1", database: "crm" }],
      },
      {
        fingerprint: "select * from ca_school",
        targets: [{ connId: "c2", database: "school" }],
        scope: "subquery",
      },
    ];
    expect(resolveSqlExecUnits(sql, "SELECT * FROM ca_school", undefined, saved, anchor)).toEqual([
      { sql: "SELECT * FROM ca_school", target: { connId: "c2", database: "school" } },
    ]);
    expect(resolveSqlExecUnits(sql, undefined, undefined, saved)).toEqual([
      {
        sql: "SELECT * FROM menu m LEFT JOIN (\n  SELECT * FROM ca_school\n) t ON 1 = 1",
        target: { connId: "c1", database: "crm" },
      },
    ]);
  });

  it("两条相同子查询按光标所在的那条对库", () => {
    const sql = "SELECT * FROM (SELECT 1) a JOIN (SELECT 1) b";
    const saved: SavedSqlStatementTarget[] = [
      { fingerprint: "select 1", targets: [{ connId: "c1", database: "a" }], scope: "subquery" },
      { fingerprint: "select 1", targets: [{ connId: "c2", database: "b" }], scope: "subquery" },
    ];
    const first = sql.indexOf("SELECT 1");
    const second = sql.indexOf("SELECT 1", first + 1);
    expect(resolveSqlExecUnits(sql, "SELECT 1", undefined, saved, first)).toEqual([
      { sql: "SELECT 1", target: { connId: "c1", database: "a" } },
    ]);
    expect(resolveSqlExecUnits(sql, "SELECT 1", undefined, saved, second)).toEqual([
      { sql: "SELECT 1", target: { connId: "c2", database: "b" } },
    ]);
  });

  it("格式化后子查询的库还在，也不会被顶层语句抢走", () => {
    const saved: SavedSqlStatementTarget[] = [
      { fingerprint: "select * from ca_school", targets: [{ connId: "c1", database: "crm" }] },
      {
        fingerprint: "select * from ca_school",
        targets: [{ connId: "c2", database: "school" }],
        scope: "subquery",
      },
    ];
    const rebound = rebindSavedStatementTargets(
      "SELECT * FROM ca_school;\nSELECT * FROM (\n  SELECT   * FROM ca_school\n) t;",
      saved,
    );
    expect(rebound).toEqual([
      { fingerprint: "select * from ca_school", targets: [{ connId: "c1", database: "crm" }] },
      {
        fingerprint: "select * from ca_school",
        targets: [{ connId: "c2", database: "school" }],
        scope: "subquery",
      },
    ]);
  });
});
