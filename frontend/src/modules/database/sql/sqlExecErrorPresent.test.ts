import { describe, expect, it } from "vitest";
import {
  buildListSessionsOnDatabaseSql,
  parseDropDatabaseStatement,
  presentSqlExecError,
  tryBuiltinSqlExecRepair,
} from "./sqlExecErrorPresent";

describe("parseDropDatabaseStatement", () => {
  it("parses simple drop database", () => {
    expect(parseDropDatabaseStatement("drop database aa12;")).toEqual({
      name: "aa12",
      ifExists: false,
    });
  });
});

describe("presentSqlExecError", () => {
  it("humanizes postgres database in use", () => {
    const raw =
      '数据库操作失败: error returned from database: database "aa12" is being accessed by other users';
    expect(presentSqlExecError(raw)).toContain("仍有其它会话");
    expect(presentSqlExecError(raw)).toContain("WITH (FORCE)");
  });
});

describe("buildListSessionsOnDatabaseSql", () => {
  it("filters pg_stat_activity by datname", () => {
    expect(buildListSessionsOnDatabaseSql("aa12", "postgres")).toContain("datname = 'aa12'");
    expect(buildListSessionsOnDatabaseSql("aa12", "postgres")).toContain("application_name");
  });
});

describe("tryBuiltinSqlExecRepair", () => {
  it("suggests FORCE for postgres drop database", () => {
    const repair = tryBuiltinSqlExecRepair(
      "drop database aa12;",
      'database "aa12" is being accessed by other users',
      "postgres",
    );
    expect(repair?.sql).toContain("pg_stat_activity");
    expect(repair?.sql).toContain('DROP DATABASE "aa12" WITH (FORCE);');
    expect(repair?.hint).toContain("应用修改");
    expect(repair?.hint).toContain("连接信息");
  });
});
