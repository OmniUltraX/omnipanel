import { describe, expect, it } from "vitest";
import type { DbColumnMeta } from "../api";
import {
  buildSqlResultUpdateStatements,
  matchSqlResultEditColumns,
  resolveSqlResultEditTarget,
  sqlResultCellDirty,
} from "./sqlResultEdit";

const columns: DbColumnMeta[] = [
  { name: "id", type: "bigint", isPk: true, isFk: false, nullable: false },
  { name: "config_key", type: "varchar(255)", isPk: false, isFk: false, nullable: false },
  { name: "value", type: "varchar(255)", isPk: false, isFk: false, nullable: true },
];

describe("resolveSqlResultEditTarget", () => {
  it("单表 SELECT 可以写回", () => {
    expect(
      resolveSqlResultEditTarget(
        "SELECT id, config_key, value FROM infra_config WHERE config_key = 'ai.chat.compress-threshold' ORDER BY id",
      ),
    ).toEqual({ tableName: "infra_config" });
  });

  it("JOIN、聚合和多语句保持只读", () => {
    expect(resolveSqlResultEditTarget("SELECT a.id FROM a JOIN b ON a.id = b.id")).toBeNull();
    expect(resolveSqlResultEditTarget("SELECT COUNT(*) FROM infra_config")).toBeNull();
    expect(resolveSqlResultEditTarget("SELECT id FROM infra_config; SELECT 1")).toBeNull();
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
});
