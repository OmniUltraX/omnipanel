import { describe, expect, it } from "vitest";
import {
  countKnowledgeChars,
  knowledgeMarkdownToHtml,
  sanitizeKnowledgeFilename,
} from "./knowledgeExport";

describe("knowledgeExport", () => {
  it("sanitizes filename", () => {
    expect(sanitizeKnowledgeFilename('a/b:c*.md')).toBe("a_b_c_.md");
  });

  it("renders headings and tables without collapsing", () => {
    const html = knowledgeMarkdownToHtml(
      "# Title\n\n| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n",
    );
    expect(html).toContain("<h1>");
    expect(html).toContain("kb-export-table-wrap");
    expect(html).toContain("<th>");
    expect(html).toContain("<td>");
  });

  it("counts characters excluding code fences", () => {
    expect(countKnowledgeChars("你好\n```\ncode\n```\n世界")).toBe(4);
  });
});
