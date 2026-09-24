import { describe, expect, it } from "vitest";
import {
  buildClearTableDataSql,
  buildCopyTableStatements,
  buildGeneratedTableSql,
  buildRenameTableSql,
  buildSetAutoIncrementSql,
  buildTruncateTableSql,
  isSafeTableIdentifier,
} from "./tableObjectSql";

describe("tableObjectSql", () => {
  it("为 MySQL 生成查询模板并带上主键条件", () => {
    expect(
      buildGeneratedTableSql(
        "mysql",
        "orders",
        [
          { name: "id", isPk: true },
          { name: "title" },
        ],
        "update",
      ),
    ).toBe("UPDATE `orders` SET `id` = ?, `title` = ? WHERE `id` = ?;");
    expect(buildGeneratedTableSql("mysql", "orders", null, "select")).toBe(
      "SELECT * FROM `orders`;",
    );
  });

  it("按引擎生成重命名、截断、清空和自增语句", () => {
    expect(buildRenameTableSql("mysql", "app", "orders", "orders_v2")).toBe(
      "RENAME TABLE `app`.`orders` TO `app`.`orders_v2`",
    );
    expect(buildRenameTableSql("postgresql", "app", "orders", "orders_v2")).toBe(
      'ALTER TABLE "orders" RENAME TO "orders_v2"',
    );
    expect(buildTruncateTableSql("mysql", "app", "orders")).toBe("TRUNCATE TABLE `app`.`orders`");
    expect(buildTruncateTableSql("sqlite", "main", "orders")).toBeNull();
    expect(buildClearTableDataSql("sqlite", "main", "orders")).toBe("DELETE FROM `orders`");
    expect(buildSetAutoIncrementSql("mysql", "app", "orders", 100)).toBe(
      "ALTER TABLE `app`.`orders` AUTO_INCREMENT = 100",
    );
    expect(buildSetAutoIncrementSql("postgresql", "app", "orders", 100)).toBeNull();
    expect(buildSetAutoIncrementSql("mysql", "app", "orders", 0)).toBeNull();
  });

  it("复制表时同时给出建表和灌数语句", () => {
    expect(buildCopyTableStatements("mysql", "app", "orders", "orders_copy")).toEqual({
      createSql: "CREATE TABLE `app`.`orders_copy` LIKE `app`.`orders`",
      insertSql: "INSERT INTO `app`.`orders_copy` SELECT * FROM `app`.`orders`",
    });
  });

  it("拒绝会破坏标识符的表名", () => {
    expect(isSafeTableIdentifier("orders_v2")).toBe(true);
    expect(isSafeTableIdentifier("a.b")).toBe(false);
    expect(isSafeTableIdentifier("a;drop")).toBe(false);
    expect(isSafeTableIdentifier("")).toBe(false);
  });
});
