import { describe, expect, it } from "vitest";
import {
  buildDatabaseSchema,
  getCompletionItems,
  introspectToTableSchemas,
} from "../language/completionItems";
import {
  cacheEntryWithIntrospectedColumns,
  completionSchemaFingerprint,
  replaceSqlCompletionSchema,
  sqlCompletionColumnsMissing,
} from "./completionSchemaSync";

const sysMenu = introspectToTableSchemas([
  {
    name: "sys_menu",
    columns: [
      { name: "menu_id", type: "bigint" },
      { name: "name", type: "varchar" },
      { name: "permission", type: "varchar" },
    ],
  },
]);

describe("completionSchemaSync", () => {
  it("浅加载的空列与拉到字段后的 schema 不是同一份", () => {
    const shallow = buildDatabaseSchema(
      "app",
      introspectToTableSchemas([{ name: "sys_menu", columns: [] }]),
    );
    const loaded = buildDatabaseSchema("app", sysMenu);
    expect(sqlCompletionColumnsMissing({ tables: [{ columns: [] }] })).toBe(true);
    expect(sqlCompletionColumnsMissing({ tables: sysMenu })).toBe(false);
    expect(replaceSqlCompletionSchema(shallow, loaded)).toBe(true);
    expect(replaceSqlCompletionSchema(loaded, loaded)).toBe(false);
    expect(completionSchemaFingerprint(shallow.tables)).not.toBe(
      completionSchemaFingerprint(loaded.tables),
    );
  });

  it("整库反射写回列，不把已有列抹成空", () => {
    const previous = {
      name: "app",
      tables: [
        {
          name: "sys_menu",
          columns: [{ name: "permission", type: "varchar", isPk: false, isFk: false }],
        },
      ],
      objectsLoaded: true,
    };
    const kept = cacheEntryWithIntrospectedColumns(previous, "app", {
      tables: [{ name: "sys_menu", columns: [] }],
    });
    expect(kept.tables[0]?.columns.map((col) => col.name)).toEqual(["permission"]);

    const replaced = cacheEntryWithIntrospectedColumns(
      { name: "app", tables: [{ name: "sys_menu", columns: [] }] },
      "app",
      {
        tables: [
          {
            name: "sys_menu",
            columns: [{ name: "permission", type: "varchar", isPk: false, isFk: false }],
          },
        ],
      },
    );
    expect(replaced.tables[0]?.columns.map((col) => col.name)).toEqual(["permission"]);
  });

  it("SELECT 列表里的字段前缀优先补当前表字段", () => {
    const sql = "SELECT menu_id, name, per FROM sys_menu WHERE permission = 'x'";
    const offset = sql.indexOf("per") + "per".length;
    const schemas = [buildDatabaseSchema("app", sysMenu, { dbType: "mysql" })];
    const labels = getCompletionItems(sql, offset, schemas, "mysql").map((item) => item.label);
    expect(labels[0]).toBe("permission");
    expect(labels.indexOf("permission")).toBeLessThan(labels.indexOf("UPPER"));
  });

  it("FROM 后补表名，不拿函数顶上", () => {
    const sql = "SELECT COUNT(*) FROM s";
    const schemas = [buildDatabaseSchema("app", sysMenu, { dbType: "mysql" })];
    const labels = getCompletionItems(sql, sql.length, schemas, "mysql").map((item) => item.label);
    expect(labels).toContain("sys_menu");
    expect(labels).not.toContain("UPPER");
  });
});
