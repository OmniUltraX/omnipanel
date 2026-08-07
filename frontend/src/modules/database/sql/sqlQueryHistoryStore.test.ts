import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifySqlHistoryKind,
  sqlHistoryKindLabel,
  sqlHistoryKindTone,
} from "./classifySqlHistoryKind";
import {
  appendSuccessfulSqlQueryHistory,
  clearSqlQueryHistory,
  listSqlQueryHistory,
  normalizeHistorySql,
} from "./sqlQueryHistoryStore";

describe("classifySqlHistoryKind", () => {
  it("识别常见语句类型", () => {
    expect(classifySqlHistoryKind("SELECT 1")).toBe("select");
    expect(classifySqlHistoryKind("insert into t values (1)")).toBe("insert");
    expect(classifySqlHistoryKind("UPDATE t SET a=1")).toBe("update");
    expect(classifySqlHistoryKind("DELETE FROM t")).toBe("delete");
    expect(classifySqlHistoryKind("CREATE TABLE t (id int)")).toBe("create");
    expect(classifySqlHistoryKind("DESC t")).toBe("describe");
  });

  it("跳过前导注释", () => {
    expect(classifySqlHistoryKind("-- note\n/* x */\nINSERT INTO t VALUES (1)")).toBe("insert");
  });

  it("tag 文案与色调", () => {
    expect(sqlHistoryKindLabel("insert")).toBe("INSERT");
    expect(sqlHistoryKindTone("insert")).toBe("write");
    expect(sqlHistoryKindTone("select")).toBe("select");
    expect(sqlHistoryKindTone("create")).toBe("schema");
  });
});

describe("appendSuccessfulSqlQueryHistory", () => {
  const scope = "tab:test-history-dedupe";

  afterEach(() => {
    clearSqlQueryHistory(scope);
    vi.useRealTimers();
  });

  it("normalizeHistorySql 去掉尾部分号", () => {
    expect(normalizeHistorySql("SELECT 1;")).toBe("SELECT 1");
    expect(normalizeHistorySql("  SELECT 1 ;; ")).toBe("SELECT 1");
  });

  it("连续相同 SQL 只保留一条并刷新时间", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    appendSuccessfulSqlQueryHistory(scope, { sql: "SELECT 1", elapsedMs: 10 });
    vi.setSystemTime(new Date("2026-01-01T00:01:00Z"));
    appendSuccessfulSqlQueryHistory(scope, { sql: "SELECT 1;", elapsedMs: 20 });
    vi.setSystemTime(new Date("2026-01-01T00:02:00Z"));
    appendSuccessfulSqlQueryHistory(scope, { sql: "SELECT 2", elapsedMs: 5 });

    const list = listSqlQueryHistory(scope);
    expect(list).toHaveLength(2);
    expect(list[0].sql).toBe("SELECT 2");
    expect(list[1].sql).toBe("SELECT 1;");
    expect(list[1].elapsedMs).toBe(20);
    expect(list[1].kind).toBe("select");
    expect(list[0].kind).toBe("select");
  });
});
