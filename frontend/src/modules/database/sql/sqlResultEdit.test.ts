import { describe, expect, it } from "vitest";
import type { DbColumnMeta } from "../api";
import {
  buildSqlResultUpdateStatements,
  matchSqlResultEditColumns,
  matchSqlResultEditColumnsForTables,
  parseSqlResultSelectOrigins,
  resolveSqlResultEditTarget,
  resolveSqlResultEditTargets,
  sqlResultCellDirty,
} from "./sqlResultEdit";

const columns: DbColumnMeta[] = [
  { name: "id", type: "bigint", isPk: true, isFk: false, nullable: false },
  { name: "config_key", type: "varchar(255)", isPk: false, isFk: false, nullable: false },
  { name: "value", type: "varchar(255)", isPk: false, isFk: false, nullable: true },
];

const authors: DbColumnMeta[] = [
  { name: "id", type: "bigint", isPk: true, isFk: false, nullable: false },
  { name: "name", type: "varchar(255)", isPk: false, isFk: false, nullable: false },
];

const posts: DbColumnMeta[] = [
  { name: "id", type: "bigint", isPk: true, isFk: false, nullable: false },
  { name: "author_id", type: "bigint", isPk: false, isFk: true, nullable: false },
  { name: "title", type: "varchar(255)", isPk: false, isFk: false, nullable: false },
];

describe("resolveSqlResultEditTarget", () => {
  it("单表 SELECT 可以写回", () => {
    expect(
      resolveSqlResultEditTarget(
        "SELECT id, config_key, value FROM infra_config WHERE config_key = 'ai.chat.compress-threshold' ORDER BY id",
      ),
    ).toEqual({ tableName: "infra_config" });
  });

  it("常见变体：LIMIT / schema.table / 别名 / WITH / FOR UPDATE / 引号保留字表名", () => {
    expect(resolveSqlResultEditTarget("SELECT * FROM users LIMIT 10")).toEqual({ tableName: "users" });
    expect(resolveSqlResultEditTarget("SELECT * FROM db.users WHERE id = 1")).toEqual({
      schemaName: "db",
      tableName: "users",
    });
    expect(resolveSqlResultEditTarget("SELECT u.* FROM users u")).toEqual({ tableName: "users" });
    expect(resolveSqlResultEditTarget("WITH c AS (SELECT 1 AS n) SELECT * FROM users")).toEqual({
      tableName: "users",
    });
    expect(resolveSqlResultEditTarget("SELECT * FROM users FOR UPDATE")).toEqual({ tableName: "users" });
    expect(resolveSqlResultEditTarget("SELECT * FROM `order`")).toEqual({ tableName: "order" });
  });

  it("聚合和多语句保持只读；JOIN 走多表接口", () => {
    expect(resolveSqlResultEditTarget("SELECT a.id FROM a JOIN b ON a.id = b.id")).toBeNull();
    expect(resolveSqlResultEditTarget("SELECT COUNT(*) FROM infra_config")).toBeNull();
    expect(resolveSqlResultEditTarget("SELECT id FROM infra_config; SELECT 1")).toBeNull();
  });
});

describe("resolveSqlResultEditTargets / parseSqlResultSelectOrigins", () => {
  it("解析 JOIN 表与列归属", () => {
    const sql =
      "SELECT a.id, a.name, b.id AS bid, b.title FROM authors a JOIN posts b ON a.id = b.author_id";
    expect(resolveSqlResultEditTargets(sql)).toEqual([
      { tableName: "authors", alias: "a" },
      { tableName: "posts", alias: "b" },
    ]);
    expect(parseSqlResultSelectOrigins(sql)).toEqual([
      { kind: "column", qualifier: "a", column: "id", outputName: "id" },
      { kind: "column", qualifier: "a", column: "name", outputName: "name" },
      { kind: "column", qualifier: "b", column: "id", outputName: "bid" },
      { kind: "column", qualifier: "b", column: "title", outputName: "title" },
    ]);
  });

  it("子查询 FROM / DISTINCT 仍整页不可写", () => {
    expect(
      resolveSqlResultEditTargets("SELECT * FROM (SELECT id FROM authors) t"),
    ).toBeNull();
    expect(
      resolveSqlResultEditTargets("SELECT DISTINCT a.id FROM authors a JOIN posts b ON a.id = b.author_id"),
    ).toBeNull();
  });
});

describe("matchSqlResultEditColumns", () => {
  it("主键不在结果里时不能编辑", () => {
    expect(matchSqlResultEditColumns(["config_key"], columns)).toBeNull();
  });

  it("按结果列名保留主键", () => {
    const matched = matchSqlResultEditColumns(["id", "value"], columns);
    expect(matched?.pkResultNames).toEqual(["id"]);
    expect(matched?.resultToTableName.value).toBe("value");
    expect(matched?.targets).toHaveLength(1);
  });
});

describe("matchSqlResultEditColumnsForTables JOIN", () => {
  it("双方主键都在结果里时，非主键列可编", () => {
    const sql =
      "SELECT a.id, a.name, b.id AS bid, b.title FROM authors a JOIN posts b ON a.id = b.author_id";
    const matched = matchSqlResultEditColumnsForTables(
      ["id", "name", "bid", "title"],
      [
        { target: { tableName: "authors", alias: "a" }, columns: authors },
        { target: { tableName: "posts", alias: "b" }, columns: posts },
      ],
      parseSqlResultSelectOrigins(sql),
    );
    expect(matched).not.toBeNull();
    expect(matched!.resultToTargetIndex.name).toBe(0);
    expect(matched!.resultToTargetIndex.title).toBe(1);
    expect(matched!.pkResultNames).toEqual(["id", "bid"]);
    expect(matched!.columnMeta.map((column) => column.name).sort()).toEqual(
      ["bid", "id", "name", "title"].sort(),
    );
  });

  it("缺一方主键时，该表列只读，另一表仍可编", () => {
    const sql = "SELECT a.id, a.name, b.title FROM authors a JOIN posts b ON a.id = b.author_id";
    const matched = matchSqlResultEditColumnsForTables(
      ["id", "name", "title"],
      [
        { target: { tableName: "authors", alias: "a" }, columns: authors },
        { target: { tableName: "posts", alias: "b" }, columns: posts },
      ],
      parseSqlResultSelectOrigins(sql),
    );
    expect(matched).not.toBeNull();
    expect(matched!.resultToTargetIndex.name).toBe(0);
    expect(matched!.resultToTargetIndex.title).toBeUndefined();
    expect(matched!.pkResultNames).toEqual(["id"]);
  });

  it("重名未限定列保持只读", () => {
    const matched = matchSqlResultEditColumnsForTables(
      ["id", "name"],
      [
        { target: { tableName: "authors" }, columns: authors },
        { target: { tableName: "posts" }, columns: posts },
      ],
      null,
    );
    // id 在两表都有 → 不映射；name 仅 authors → 可映射，但 authors 主键 id 未映射成功 → 整表不可编
    expect(matched).toBeNull();
  });

  it("表达式别名不可按列名误匹配为可编辑", () => {
    const sql =
      "SELECT a.id, a.name, UPPER(b.title) AS title FROM authors a JOIN posts b ON a.id = b.author_id";
    const matched = matchSqlResultEditColumnsForTables(
      ["id", "name", "title"],
      [
        { target: { tableName: "authors", alias: "a" }, columns: authors },
        { target: { tableName: "posts", alias: "b" }, columns: posts },
      ],
      parseSqlResultSelectOrigins(sql),
    );
    expect(matched).not.toBeNull();
    expect(matched!.resultToTargetIndex.name).toBe(0);
    expect(matched!.resultToTargetIndex.title).toBeUndefined();
  });
});

describe("sqlResultCellDirty / buildSqlResultUpdateStatements", () => {
  it("生成带主键条件的 UPDATE", () => {
    const matched = matchSqlResultEditColumns(["id", "value"], columns);
    expect(matched).not.toBeNull();
    const dirty = sqlResultCellDirty(
      {},
      { id: 25, value: "2300" },
      matched!.pkResultNames,
      "value",
      "2400",
    );
    expect(
      buildSqlResultUpdateStatements({
        dbType: "mysql",
        tableName: "infra_config",
        dirty,
        pkResultNames: matched!.pkResultNames,
        resultToTableName: matched!.resultToTableName,
        columnTypeByResultName: matched!.columnTypeByResultName,
      }),
    ).toEqual(["UPDATE `infra_config` SET `value` = '2400' WHERE `id` = '25' LIMIT 1"]);
  });

  it("连表脏数据按表拆成多条 UPDATE", () => {
    const sql =
      "SELECT a.id, a.name, b.id AS bid, b.title FROM authors a JOIN posts b ON a.id = b.author_id";
    const matched = matchSqlResultEditColumnsForTables(
      ["id", "name", "bid", "title"],
      [
        { target: { tableName: "authors", alias: "a" }, columns: authors },
        { target: { tableName: "posts", alias: "b" }, columns: posts },
      ],
      parseSqlResultSelectOrigins(sql),
    );
    expect(matched).not.toBeNull();
    let dirty = sqlResultCellDirty(
      {},
      { id: 1, name: "Ann", bid: 10, title: "Hello" },
      matched!.pkResultNames,
      "name",
      "Bob",
    );
    dirty = sqlResultCellDirty(
      dirty,
      { id: 1, name: "Ann", bid: 10, title: "Hello" },
      matched!.pkResultNames,
      "title",
      "World",
      "Hello",
    );
    expect(
      buildSqlResultUpdateStatements({
        dbType: "mysql",
        dirty,
        targets: matched!.targets,
        pkResultNamesByTarget: matched!.pkResultNamesByTarget,
        resultToTargetIndex: matched!.resultToTargetIndex,
        resultToTableName: matched!.resultToTableName,
        columnTypeByResultName: matched!.columnTypeByResultName,
      }),
    ).toEqual([
      "UPDATE `authors` SET `name` = 'Bob' WHERE `id` = '1' LIMIT 1",
      "UPDATE `posts` SET `title` = 'World' WHERE `id` = '10' LIMIT 1",
    ]);
  });
});
