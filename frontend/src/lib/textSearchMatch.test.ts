import { describe, expect, it } from "vitest";
import { getTextSearchMatchIndices, textSearchMatches } from "./textSearchMatch";

describe("textSearchMatches separator-aware matching", () => {
  const tableName = "sys_user_test";

  it("matches literal substring", () => {
    expect(textSearchMatches("user", tableName)).toBe(true);
    expect(textSearchMatches("sys_user", tableName)).toBe(true);
  });

  it("matches compact prefix across underscores", () => {
    expect(textSearchMatches("sysu", tableName)).toBe(true);
    expect(textSearchMatches("sut", tableName)).toBe(true);
  });

  it("matches space-separated tokens in order", () => {
    expect(textSearchMatches("sys ut", tableName)).toBe(true);
    expect(textSearchMatches("sys user", tableName)).toBe(true);
    expect(textSearchMatches("user test", tableName)).toBe(true);
  });

  it("rejects out-of-order tokens", () => {
    expect(textSearchMatches("ut sys", tableName)).toBe(false);
    expect(textSearchMatches("test sys", tableName)).toBe(false);
  });

  it("rejects unrelated queries", () => {
    expect(textSearchMatches("xyz", tableName)).toBe(false);
    expect(textSearchMatches("sys xyz", tableName)).toBe(false);
  });
});

describe("getTextSearchMatchIndices highlighting", () => {
  it("highlights compact subsequence matches", () => {
    expect(getTextSearchMatchIndices("sys_user_test", "sysu")).toEqual([0, 1, 2, 4]);
  });

  it("highlights each token for spaced queries", () => {
    expect(getTextSearchMatchIndices("sys_user_test", "sys ut")).toEqual([0, 1, 2, 4, 9]);
  });
});
