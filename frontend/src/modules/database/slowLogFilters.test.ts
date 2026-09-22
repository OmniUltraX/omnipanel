import { describe, expect, it } from "vitest";
import { parseMysqlSlowLogNewestOutput } from "./mysqlSlowQueryLog";
import { compileSlowLogFilter, type SlowLogFilterEntry } from "./slowLogFilters";

const entry = (sql: string, extra: Partial<SlowLogFilterEntry> = {}): SlowLogFilterEntry => ({
  time: "2026-09-22T16:00:00.000000Z",
  userHost: "root[root] @ localhost []",
  queryTime: 1.5,
  sql,
  ...extra,
});

describe("compileSlowLogFilter", () => {
  it("按库名和表名过滤 USE 与限定名", () => {
    const match = compileSlowLogFilter({
      dateFrom: "",
      dateTo: "",
      minQueryTime: "",
      databases: ["english-study"],
      tables: ["english-study.teacher"],
      keyword: "",
    });

    expect(match(entry("SELECT * FROM `english-study`.`teacher` WHERE id = 1"))).toBe(true);
    expect(match(entry("USE `english-study`;\nSELECT * FROM teacher WHERE id = 1"))).toBe(true);
    expect(match(entry("SELECT * FROM `teacher-chat`.`reading`"))).toBe(false);
  });

  it("最小耗时按大于等于比较，关键字同时看 SQL 和用户", () => {
    const match = compileSlowLogFilter({
      dateFrom: "2026-09-22T15:00",
      dateTo: "2026-09-22T17:00",
      minQueryTime: "1.5",
      databases: [],
      tables: [],
      keyword: "localhost",
    });

    expect(match(entry("SELECT 1"))).toBe(true);
    expect(match(entry("SELECT 1", { queryTime: 1.4 }))).toBe(false);
    expect(match(entry("SELECT 1", { userHost: "app@10.0.0.1" }))).toBe(false);
  });
});

describe("parseMysqlSlowLogNewestOutput", () => {
  it("拆出文件大小和尾部正文", () => {
    expect(parseMysqlSlowLogNewestOutput("OMNI_SIZE 120\n# Time: 2026-09-22\nSELECT 1;\n")).toEqual({
      size: 120,
      text: "# Time: 2026-09-22\nSELECT 1;\n",
    });
  });
});
