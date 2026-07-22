import { describe, expect, it } from "vitest";
import { isReadOnlySql, isSafeDatabaseToolPermission, stripSqlLeadingTrivia } from "./sqlSafety";

describe("stripSqlLeadingTrivia", () => {
  it("strips line and block comments", () => {
    expect(stripSqlLeadingTrivia("-- hello\nSELECT 1")).toBe("SELECT 1");
    expect(stripSqlLeadingTrivia("/* c */\nSELECT 1")).toBe("SELECT 1");
    expect(stripSqlLeadingTrivia("# mysql\nSHOW TABLES")).toBe("SHOW TABLES");
  });
});

describe("isReadOnlySql", () => {
  it("treats select/show/explain as read-only", () => {
    expect(isReadOnlySql("SELECT * FROM users")).toBe(true);
    expect(isReadOnlySql("show tables")).toBe(true);
    expect(isReadOnlySql("EXPLAIN SELECT 1")).toBe(true);
  });

  it("allows leading comments before select", () => {
    expect(isReadOnlySql("-- query users\nSELECT * FROM users")).toBe(true);
    expect(isReadOnlySql("/* q */ SELECT id FROM t")).toBe(true);
  });

  it("allows USE/SET prefix with select", () => {
    expect(isReadOnlySql("USE app;\nSELECT * FROM users")).toBe(true);
    expect(isReadOnlySql("SET NAMES utf8mb4; SELECT 1")).toBe(true);
  });

  it("requires approval for writes", () => {
    expect(isReadOnlySql("DELETE FROM users")).toBe(false);
    expect(isReadOnlySql("UPDATE users SET a=1")).toBe(false);
    expect(isReadOnlySql("INSERT INTO t VALUES (1)")).toBe(false);
    expect(isReadOnlySql("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x")).toBe(false);
  });

  it("allows WITH select but not WITH write", () => {
    expect(isReadOnlySql("WITH cte AS (SELECT 1 AS n) SELECT * FROM cte")).toBe(true);
  });
});

describe("isSafeDatabaseToolPermission", () => {
  it("auto-allows metadata tools and read-only execute_sql", () => {
    expect(isSafeDatabaseToolPermission("omni_database_get_tables_from_database", "{}")).toBe(
      true,
    );
    expect(
      isSafeDatabaseToolPermission(
        "omni_database_execute_sql",
        JSON.stringify({ sql: "SELECT 1" }),
      ),
    ).toBe(true);
    expect(
      isSafeDatabaseToolPermission(
        "omni_database_execute_sql",
        JSON.stringify({ sql: "DELETE FROM t" }),
      ),
    ).toBe(false);
  });
});
