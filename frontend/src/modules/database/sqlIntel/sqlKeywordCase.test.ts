import { describe, expect, it } from "vitest";
import { applySqlKeywordCase } from "./sqlKeywordCase";

describe("applySqlKeywordCase", () => {
  it("lowercases keywords in snippets", () => {
    const sql = "SELECT id\nFROM users\nWHERE status = 1";
    expect(applySqlKeywordCase(sql, "lower")).toBe("select id\nfrom users\nwhere status = 1");
  });

  it("uppercases keywords in snippets", () => {
    const sql = "select count(*) from users group by id";
    expect(applySqlKeywordCase(sql, "upper")).toBe("SELECT COUNT(*) FROM users GROUP BY id");
  });
});
