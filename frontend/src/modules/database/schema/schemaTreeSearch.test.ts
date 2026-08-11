import { describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  connectionHasTableSchemaChildren: () => true,
  isConnectionEnabled: () => true,
  isRedisConnection: () => false,
}));

import type { CachedConnection, CachedDatabase, CachedTable } from "./schemaCacheMerge";
import {
  schemaConnectionSubtreeMatchesSearch,
  schemaDatabaseSubtreeMatchesSearch,
  schemaTableObjectSubtreeMatchesSearch,
} from "./schemaTreeSearch";

const labels = {
  tables: "表",
  views: "视图",
  other: "其他",
  fields: "字段",
  indexes: "索引",
  users: "用户",
};

function makeTable(partial: Partial<CachedTable> & { name: string }): CachedTable {
  return {
    name: partial.name,
    comment: partial.comment,
    columns: partial.columns,
    indexes: partial.indexes,
  };
}

describe("schemaTreeSearch cache-wide matching", () => {
  it("matches cached columns without requiring expand state", () => {
    const table = makeTable({
      name: "orders",
      columns: [{ name: "customer_profile", type: "varchar" }],
    });
    expect(schemaTableObjectSubtreeMatchesSearch("profile", table, "table")).toBe(true);
    expect(schemaTableObjectSubtreeMatchesSearch("orders", table, "table")).toBe(true);
    expect(schemaTableObjectSubtreeMatchesSearch("missing", table, "table")).toBe(false);
  });

  it("database subtree can include cached column hits", () => {
    const db: CachedDatabase = {
      name: "shop",
      tables: [
        makeTable({
          name: "orders",
          columns: [{ name: "customer_profile", type: "varchar" }],
        }),
      ],
      views: [],
      routines: [],
      objectsLoaded: true,
    };
    expect(
      schemaDatabaseSubtreeMatchesSearch("profile", db, undefined, labels, () => "fn", false),
    ).toBe(false);
    expect(
      schemaDatabaseSubtreeMatchesSearch("profile", db, undefined, labels, () => "fn", true),
    ).toBe(true);
  });

  it("connection subtree matches cached users without expand", () => {
    const conn: CachedConnection = {
      config: {
        id: "c1",
        name: "local",
        db_type: "mysql",
        host: "127.0.0.1",
        port: 3306,
        user: "root",
        password: "",
        database: "shop",
        ssl: false,
        group: "default",
        status: "disconnected",
      },
      databases: [{ name: "shop", tables: [], views: [], routines: [], objectsLoaded: true }],
      users: [{ name: "readonly_app", host: "%" }],
    };
    expect(
      schemaConnectionSubtreeMatchesSearch(
        "readonly",
        conn,
        {},
        (connId, dbName) => `${connId}:${dbName}`,
        labels,
        () => "fn",
      ),
    ).toBe(true);
  });
});
