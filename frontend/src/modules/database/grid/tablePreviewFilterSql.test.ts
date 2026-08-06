import { describe, expect, it } from "vitest";
import {
  buildOrderByClauseText,
  buildWhereClauseText,
  parseOrderByClauseText,
  parseWhereClauseText,
} from "./tablePreviewFilterSql";
import { ensureTableFilterQuery } from "./tablePreviewFilter";

describe("tablePreviewFilterSql", () => {
  it("buildOrderByClauseText formats sort", () => {
    expect(buildOrderByClauseText({ column: "id", direction: "asc" })).toBe("id ASC");
    expect(buildOrderByClauseText(null)).toBe("");
  });

  it("parseOrderByClauseText round-trips", () => {
    expect(parseOrderByClauseText("chapter_id DESC")).toEqual({
      ok: true,
      sort: { column: "chapter_id", direction: "desc" },
    });
    expect(parseOrderByClauseText("")).toEqual({ ok: true, sort: null });
    expect(parseOrderByClauseText("!!!")).toMatchObject({ ok: false });
  });

  it("parseWhereClauseText handles comparison and AND", () => {
    const parsed = parseWhereClauseText("status = 1 AND name LIKE '%a%'");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filter?.rules).toHaveLength(2);
  });

  it("parseWhereClauseText handles IS NULL", () => {
    const parsed = parseWhereClauseText("audio_url IS NULL");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filter?.rules[0]).toMatchObject({
      field: "audio_url",
      operator: "null",
    });
  });

  it("empty where clears filter", () => {
    expect(parseWhereClauseText("  ")).toEqual({ ok: true, filter: null });
  });

  it("buildWhereClauseText uses formatFilterWhere", () => {
    const filter = ensureTableFilterQuery({
      combinator: "and",
      rules: [{ field: "id", operator: "=", value: 1 }],
    });
    const text = buildWhereClauseText(filter, "postgres");
    expect(text.toLowerCase()).toContain("id");
    expect(text).toContain("1");
    // 不应保留 formatQuery 的最外层括号，否则回车规范化后难以再编辑
    expect(text.trim().startsWith("(")).toBe(false);
  });

  it("parseWhereClauseText accepts formerly paren-wrapped clauses", () => {
    const parsed = parseWhereClauseText("(status = 1)");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filter?.rules[0]).toMatchObject({ field: "status", operator: "=" });
  });
});
