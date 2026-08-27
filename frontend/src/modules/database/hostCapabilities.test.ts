import { describe, expect, it } from "vitest";
import { catalogFamily, hostCapabilities } from "./hostCapabilities";

describe("hostCapabilities", () => {
  it("mysql / pg 打开建库、克隆、删表与连接信息多余页签", () => {
    const mysql = hostCapabilities("mysql");
    expect(mysql.createDatabase).toBe(true);
    expect(mysql.cloneTable).toBe(true);
    expect(mysql.dropTable).toBe(true);
    expect(mysql.tableDesign).toBe(true);
    expect(mysql.users).toBe(true);
    expect(mysql.binlog).toBe(true);
    expect(mysql.slowQuery).toBe(true);
    expect(mysql.connectionInfoExtra).toBe(true);

    const pg = hostCapabilities("postgresql");
    expect(pg.createDatabase).toBe(true);
    expect(pg.users).toBe(true);
    expect(pg.binlog).toBe(false);
    expect(pg.slowQuery).toBe(true);
    expect(pg.connectionInfoExtra).toBe(true);
    expect(pg.tableDesign).toBe(true);
  });

  it("sqlite 可建库/克隆/删表，无连接信息多余页签", () => {
    const sqlite = hostCapabilities("sqlite");
    expect(sqlite.createDatabase).toBe(true);
    expect(sqlite.cloneTable).toBe(true);
    expect(sqlite.dropTable).toBe(true);
    expect(sqlite.tableDesign).toBe(true);
    expect(sqlite.connectionInfoExtra).toBe(false);
    expect(sqlite.users).toBe(false);
  });

  it("oracle / 达梦按 Oracle 系打开表设计、用户、删表和克隆", () => {
    for (const engine of ["oracle", "dameng", "db2"]) {
      const caps = hostCapabilities(engine);
      expect(catalogFamily(engine), engine).toBe("oracleLike");
      expect(caps.tableDesign, engine).toBe(true);
      expect(caps.users, engine).toBe(true);
      expect(caps.dropTable, engine).toBe(true);
      expect(caps.cloneTable, engine).toBe(true);
      expect(caps.binlog, engine).toBe(false);
      expect(caps.slowQuery, engine).toBe(true);
      expect(caps.createDatabase, engine).toBe(true);
      expect(caps.connectionInfoExtra, engine).toBe(true);
    }
  });

  it("PG 系 / MySQL 系 sidecar 打开建库、连接信息与慢查询，不打开 Binlog", () => {
    const kingbase = hostCapabilities("kingbase");
    expect(catalogFamily("kingbase")).toBe("postgresLike");
    expect(kingbase.tableDesign).toBe(true);
    expect(kingbase.users).toBe(true);
    expect(kingbase.createDatabase).toBe(true);
    expect(kingbase.connectionInfoExtra).toBe(true);
    expect(kingbase.slowQuery).toBe(true);
    expect(kingbase.binlog).toBe(false);

    const tidb = hostCapabilities("tidb");
    expect(catalogFamily("tidb")).toBe("mysqlLike");
    expect(tidb.tableDesign).toBe(true);
    expect(tidb.users).toBe(true);
    expect(tidb.createDatabase).toBe(true);
    expect(tidb.binlog).toBe(false);
  });

  it("Hive 可表设计/删表/克隆，无用户页", () => {
    const hive = hostCapabilities("hive");
    expect(catalogFamily("hive")).toBe("hiveLike");
    expect(hive.tableDesign).toBe(true);
    expect(hive.dropTable).toBe(true);
    expect(hive.cloneTable).toBe(true);
    expect(hive.users).toBe(false);
    expect(hive.createDatabase).toBe(false);
  });

  it("neo4j / cassandra 保持非 SQL 入口关闭", () => {
    for (const engine of ["neo4j", "cassandra"]) {
      const caps = hostCapabilities(engine);
      expect(catalogFamily(engine), engine).toBe("nonSql");
      expect(caps.tableDesign, engine).toBe(false);
      expect(caps.users, engine).toBe(false);
      expect(caps.dropTable, engine).toBe(false);
      expect(caps.cloneTable, engine).toBe(false);
    }
  });

  it("sqlserver 打开建库、克隆、删表、用户与连接信息", () => {
    const mssql = hostCapabilities("mssql");
    expect(mssql.tableDesign).toBe(true);
    expect(mssql.createDatabase).toBe(true);
    expect(mssql.cloneTable).toBe(true);
    expect(mssql.dropTable).toBe(true);
    expect(mssql.users).toBe(true);
    expect(mssql.connectionInfoExtra).toBe(true);
    expect(mssql.slowQuery).toBe(true);
    expect(mssql.binlog).toBe(false);
  });
});
