import { describe, expect, it } from "vitest";
import type { DbColumnMeta } from "../api";
import type { TableSchema } from "../types";
import {
  appendQuickFilterRule,
  buildFilterFields,
  buildPreviewFilterFields,
  buildQuickFilterRule,
  buildSelectAllFromTableSql,
  buildTablePreviewCountSqlWithRelations,
  buildTablePreviewDataSqlWithRelations,
  buildTablePreviewSql,
  clearColumnFilter,
  filterOperatorNeedsValue,
  formatFilterWhere,
  getFilterColumnNames,
  isEmptyFilterValue,
  isQuickFilterKindEnabled,
  pruneEmptyFilterRules,
  shouldUseRelationJoinPreview,
} from "./tablePreviewFilter";
import { relationDisplayColumnId } from "./tableColumnRelation";

const BIGINT_VALUE = "2064901285657460737";
const CORRUPTED_VALUE = "2064901285657460700";

describe("tablePreviewFilter bigint", () => {
  const columnMeta: DbColumnMeta[] = [{ name: "id", type: "BIGINT", isPk: true, isFk: false }];

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
    expect(
      shouldUseRelationJoinPreview(columnRelations, null, [
        { column: relationColumnId, direction: "asc" },
      ]),
    ).toBe(true);
    expect(
      shouldUseRelationJoinPreview(columnRelations, null, [{ column: "user_id", direction: "asc" }]),
    ).toBe(false);
  });

  it("builds join SQL with relation filter and sort", () => {
    const filter = {
      combinator: "and" as const,
      rules: [{ field: relationColumnId, operator: "contains", value: "alice" }],
    };
    const sort = [{ column: relationColumnId, direction: "asc" as const }];
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

describe("tablePreviewFilter quick filter", () => {
  it("builds equals and null fallback", () => {
    expect(buildQuickFilterRule("name", "equals", "alice")).toMatchObject({
      field: "name",
      operator: "=",
      value: "alice",
    });
    expect(buildQuickFilterRule("name", "equals", null)).toMatchObject({
      field: "name",
      operator: "null",
    });
    expect(buildQuickFilterRule("name", "notEquals", null)).toMatchObject({
      field: "name",
      operator: "notNull",
    });
    expect(buildQuickFilterRule("name", "contains", null)).toBeNull();
    expect(isQuickFilterKindEnabled("contains", null)).toBe(false);
    expect(isQuickFilterKindEnabled("equals", null)).toBe(true);
  });

  it("appends with AND and clears column", () => {
    const base = {
      combinator: "and" as const,
      rules: [{ field: "id", operator: "=", value: 1 }],
    };
    const next = appendQuickFilterRule(base, "name", "contains", "alice");
    expect(next?.rules).toHaveLength(2);
    const cleared = clearColumnFilter(next, "name");
    expect(cleared?.rules).toHaveLength(1);
    expect(clearColumnFilter(cleared, "id")).toBeNull();
  });

  it("generates SQL for contains and doesNotContain", () => {
    const containsSql = formatFilterWhere(
      {
        combinator: "and" as const,
        rules: [buildQuickFilterRule("name", "contains", "alice")!],
      },
      "mysql",
    );
    expect(containsSql?.toLowerCase()).toContain("like");
    const notContainsSql = formatFilterWhere(
      {
        combinator: "and" as const,
        rules: [buildQuickFilterRule("name", "notContains", "alice")!],
      },
      "mysql",
    );
    expect(notContainsSql?.toLowerCase()).toContain("not like");
  });
});

describe("tablePreviewFilter empty values", () => {
  const columnMeta: DbColumnMeta[] = [
    { name: "created_at", type: "DATETIME", isPk: false, isFk: false },
  ];

  it("treats blank strings / null / empty arrays as empty", () => {
    expect(isEmptyFilterValue("")).toBe(true);
    expect(isEmptyFilterValue("   ")).toBe(true);
    expect(isEmptyFilterValue(null)).toBe(true);
    expect(isEmptyFilterValue(undefined)).toBe(true);
    expect(isEmptyFilterValue([])).toBe(true);
    expect(isEmptyFilterValue("2026-09-11 12:30:00")).toBe(false);
    expect(isEmptyFilterValue(0)).toBe(false);
    expect(isEmptyFilterValue(false)).toBe(false);
  });

  it("knows which operators do not need a value", () => {
    expect(filterOperatorNeedsValue("=")).toBe(true);
    expect(filterOperatorNeedsValue(">")).toBe(true);
    expect(filterOperatorNeedsValue("null")).toBe(false);
    expect(filterOperatorNeedsValue("notNull")).toBe(false);
  });

  it("drops rules whose value is empty", () => {
    const pruned = pruneEmptyFilterRules({
      combinator: "and",
      rules: [
        { field: "created_at", operator: "=", value: "" },
        { field: "created_at", operator: "notNull", value: null },
      ],
    });
    expect(pruned?.rules).toHaveLength(1);
    expect(pruned?.rules[0]).toMatchObject({ operator: "notNull" });
    expect(
      pruneEmptyFilterRules({
        combinator: "and",
        rules: [{ field: "created_at", operator: "=", value: "" }],
      }),
    ).toBeNull();
  });

  it("never formats blank datetime values into SQL", () => {
    expect(
      formatFilterWhere(
        { combinator: "and", rules: [{ field: "created_at", operator: "=", value: "" }] },
        "mysql",
        columnMeta,
      ),
    ).toBeUndefined();
    expect(getFilterColumnNames({
      combinator: "and",
      rules: [{ field: "created_at", operator: "=", value: "" }],
    }).size).toBe(0);
  });

  it("keeps the filled rule when mixing blank and real values", () => {
    const sql = formatFilterWhere(
      {
        combinator: "and",
        rules: [
          { field: "created_at", operator: "=", value: "" },
          { field: "created_at", operator: ">=", value: "2026-09-01 00:00:00" },
        ],
      },
      "mysql",
      columnMeta,
    );
    expect(sql).toContain("2026-09-01 00:00:00");
    expect(sql).not.toContain("''");
  });
});

describe("buildTablePreviewSql dialects", () => {
  it("uses FETCH for SQL Server and Cypher for Neo4j", () => {
    expect(
      buildTablePreviewSql({
        dbType: "sqlserver",
        tableName: "dbo.t",
        page: 0,
        pageSize: 20,
      }),
    ).toBe("SELECT * FROM [dbo].[t] ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 20 ROWS ONLY");
    expect(
      buildTablePreviewSql({
        dbType: "neo4j",
        tableName: "Person",
        page: 1,
        pageSize: 20,
      }),
    ).toBe("MATCH (n:Person) RETURN n SKIP 20 LIMIT 20");
    expect(
      buildTablePreviewSql({
        dbType: "cassandra",
        tableName: "ks.t",
        page: 2,
        pageSize: 50,
      }),
    ).toBe('SELECT * FROM "ks.t" LIMIT 50');
    expect(buildSelectAllFromTableSql("neo4j", "Person")).toBe(
      "MATCH (n:Person) RETURN n LIMIT 50;",
    );
  });
});
