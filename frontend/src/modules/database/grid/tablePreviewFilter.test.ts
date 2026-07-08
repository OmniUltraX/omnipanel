import { describe, expect, it } from "vitest";
import type { DbColumnMeta } from "../api";
import type { TableSchema } from "../types";
import {
  buildFilterFields,
  buildPreviewFilterFields,
  buildTablePreviewCountSqlWithRelations,
  buildTablePreviewDataSqlWithRelations,
  formatFilterWhere,
  shouldUseRelationJoinPreview,
} from "./tablePreviewFilter";
import { relationDisplayColumnId } from "./tableColumnRelation";

const BIGINT_VALUE = "2064901285657460737";
const CORRUPTED_VALUE = "2064901285657460700";

describe("tablePreviewFilter bigint", () => {
  const columnMeta: DbColumnMeta[] = [{ name: "id", type: "BIGINT", isPk: true }];

  it("uses bigint input type for BIGINT columns", () => {
    const fields = buildFilterFields(columnMeta);
    expect(fields[0]?.inputType).toBe("bigint");
  });

  it("preserves large integer literals in WHERE SQL", () => {
    const filter = {
      combinator: "and" as const,
      rules: [{ field: "id", operator: "=", value: BIGINT_VALUE }],
    };
    const sql = formatFilterWhere(filter, "mysql", columnMeta);
    expect(sql).toContain(BIGINT_VALUE);
    expect(sql).not.toContain(CORRUPTED_VALUE);
  });
});

describe("tablePreviewFilter relation columns", () => {
  const columnRelations = {
    user_id: {
      tableName: "users",
      fieldName: "id",
      displayFieldName: "name",
    },
  };
  const relationTables: TableSchema[] = [
    {
      name: "users",
      kind: "table",
      columns: [
        { name: "id", type: "INT", isPK: true },
        { name: "name", type: "VARCHAR(255)" },
      ],
    },
  ];
  const relationColumnId = relationDisplayColumnId("user_id");

  it("includes relation display columns in preview filter fields", () => {
    const fields = buildPreviewFilterFields([], columnRelations, relationTables);
    expect(fields.some((field) => field.name === relationColumnId)).toBe(true);
  });

  it("detects when join preview is required", () => {
    const filter = {
      combinator: "and" as const,
      rules: [{ field: relationColumnId, operator: "contains", value: "alice" }],
    };
    expect(shouldUseRelationJoinPreview(columnRelations, filter, null)).toBe(true);
    expect(shouldUseRelationJoinPreview(columnRelations, null, { column: relationColumnId, direction: "asc" })).toBe(
      true,
    );
    expect(shouldUseRelationJoinPreview(columnRelations, null, { column: "user_id", direction: "asc" })).toBe(false);
  });

  it("builds join SQL with relation filter and sort", () => {
    const filter = {
      combinator: "and" as const,
      rules: [{ field: relationColumnId, operator: "contains", value: "alice" }],
    };
    const sort = { column: relationColumnId, direction: "asc" as const };
    const dataSql = buildTablePreviewDataSqlWithRelations({
      dbType: "mysql",
      tableName: "orders",
      filter,
      sort,
      page: 0,
      pageSize: 100,
      columnRelations,
      relationTables,
    });
    expect(dataSql).toContain("LEFT JOIN `users` AS `rel_0`");
    expect(dataSql).toContain("`rel_0`.`name` AS `__rel__:user_id`");
    expect(dataSql.toLowerCase()).toContain("`rel_0`.`name` like '%alice%'");
    expect(dataSql).toContain("ORDER BY `rel_0`.`name` ASC");

    const countSql = buildTablePreviewCountSqlWithRelations({
      dbType: "mysql",
      tableName: "orders",
      filter,
      columnRelations,
      relationTables,
    });
    expect(countSql).toContain("SELECT COUNT(*)");
    expect(countSql).toContain("LEFT JOIN `users` AS `rel_0`");
    expect(countSql.toLowerCase()).toContain("`rel_0`.`name` like '%alice%'");
  });
});