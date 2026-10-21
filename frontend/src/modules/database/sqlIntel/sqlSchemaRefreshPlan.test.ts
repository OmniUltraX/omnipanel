import { describe, expect, it } from "vitest";
import { collectSqlSchemaRefreshPlans } from "./sqlSchemaRefreshPlan";

const connId = "conn-1";

describe("collectSqlSchemaRefreshPlans", () => {
  it("refreshes connection after CREATE DATABASE", () => {
    expect(collectSqlSchemaRefreshPlans("CREATE DATABASE aa;", connId, "")).toEqual([
      { level: "connection", connId },
    ]);
  });

  it("refreshes active database after CREATE TABLE", () => {
    expect(collectSqlSchemaRefreshPlans("CREATE TABLE t (id int);", connId, "app")).toEqual([
      { level: "database", connId, dbName: "app" },
    ]);
  });

  it("uses qualified database name when present", () => {
    expect(
      collectSqlSchemaRefreshPlans("DROP TABLE `other`.`users`;", connId, "app"),
    ).toEqual([{ level: "database", connId, dbName: "other" }]);
  });

  it("ignores SELECT", () => {
    expect(collectSqlSchemaRefreshPlans("SELECT 1;", connId, "app")).toEqual([]);
  });

  it("prefers connection refresh when mixed with database DDL", () => {
    expect(
      collectSqlSchemaRefreshPlans(
        "CREATE DATABASE x;\nCREATE TABLE t (id int);",
        connId,
        "app",
      ),
    ).toEqual([{ level: "connection", connId }]);
  });
});
