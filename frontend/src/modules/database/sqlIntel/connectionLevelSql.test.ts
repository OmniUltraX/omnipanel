import { describe, expect, it } from "vitest";
import { isConnectionLevelSql, sqlRequiresDatabaseContext } from "./connectionLevelSql";

describe("isConnectionLevelSql", () => {
  it("recognizes SHOW admin statements", () => {
    expect(isConnectionLevelSql("SHOW VARIABLES LIKE 'pid_file';")).toBe(true);
    expect(isConnectionLevelSql("SHOW FULL PROCESSLIST;")).toBe(true);
    expect(isConnectionLevelSql("SHOW PROCESSLIST;")).toBe(true);
    expect(isConnectionLevelSql("SHOW STATUS;")).toBe(true);
  });

  it("rejects regular DML/DQL", () => {
    expect(isConnectionLevelSql("SELECT * FROM users;")).toBe(false);
    expect(isConnectionLevelSql("UPDATE t SET a = 1;")).toBe(false);
  });

  it("recognizes database/schema DDL", () => {
    expect(isConnectionLevelSql("CREATE DATABASE aa;")).toBe(true);
    expect(isConnectionLevelSql("CREATE DATABASE IF NOT EXISTS aa;")).toBe(true);
    expect(isConnectionLevelSql("DROP DATABASE bb;")).toBe(true);
    expect(isConnectionLevelSql("ALTER DATABASE cc CHARSET utf8mb4;")).toBe(true);
    expect(isConnectionLevelSql("CREATE SCHEMA s1;")).toBe(true);
    expect(isConnectionLevelSql("CREATE TABLE t (id int);")).toBe(false);
  });
});

describe("sqlRequiresDatabaseContext", () => {
  it("allows connection-level statements without database", () => {
    expect(sqlRequiresDatabaseContext("SHOW VARIABLES;")).toBe(false);
    expect(sqlRequiresDatabaseContext("SHOW FULL PROCESSLIST;")).toBe(false);
    expect(sqlRequiresDatabaseContext("CREATE DATABASE aa;")).toBe(false);
  });

  it("requires database when mixed with regular SQL", () => {
    expect(sqlRequiresDatabaseContext("SHOW VARIABLES;\nSELECT 1;")).toBe(true);
  });
});
