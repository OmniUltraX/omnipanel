import { describe, expect, it, beforeEach } from "vitest";
import {
  getSqlCompletionUsageBoost,
  recordSqlCompletionUsage,
  resetSqlCompletionUsageForTests,
  SQL_COMPLETION_USAGE_BOOST_STEP,
} from "./sqlCompletionUsage";

describe("sqlCompletionUsage", () => {
  beforeEach(() => {
    resetSqlCompletionUsageForTests();
  });

  it("returns zero boost before any usage", () => {
    expect(getSqlCompletionUsageBoost(5, "user_id")).toBe(0);
  });

  it("increases boost after recording usage", () => {
    recordSqlCompletionUsage(5, "user_id");
    recordSqlCompletionUsage(5, "user_id");
    expect(getSqlCompletionUsageBoost(5, "user_id")).toBe(2 * SQL_COMPLETION_USAGE_BOOST_STEP);
  });

  it("tracks usage independently by kind and label", () => {
    recordSqlCompletionUsage(5, "id");
    recordSqlCompletionUsage(22, "users");
    expect(getSqlCompletionUsageBoost(5, "id")).toBe(SQL_COMPLETION_USAGE_BOOST_STEP);
    expect(getSqlCompletionUsageBoost(22, "users")).toBe(SQL_COMPLETION_USAGE_BOOST_STEP);
    expect(getSqlCompletionUsageBoost(5, "users")).toBe(0);
  });
});
