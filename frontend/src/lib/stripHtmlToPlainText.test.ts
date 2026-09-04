import { describe, expect, it } from "vitest";
import { stripHtmlToPlainText } from "./stripHtmlToPlainText";

describe("stripHtmlToPlainText", () => {
  it("strips bt soft-store description spans", () => {
    const raw =
      '<span class="description-line">MySQL是一种关系数据库管理系统!</span>';
    expect(stripHtmlToPlainText(raw)).toBe("MySQL是一种关系数据库管理系统!");
  });

  it("decodes entities and collapses whitespace", () => {
    expect(stripHtmlToPlainText("<p>A&amp;B</p><br/>C")).toBe("A&B C");
  });

  it("returns empty for blank input", () => {
    expect(stripHtmlToPlainText("")).toBe("");
    expect(stripHtmlToPlainText("   ")).toBe("");
    expect(stripHtmlToPlainText(null)).toBe("");
  });
});
