import { describe, expect, it } from "vitest";
import {
  compressSql,
  deleteEmptyLines,
  expandSelectStar,
  quoteSqlIdent,
  toDelimitedList,
  toggleBlockComment,
  toggleLineComment,
} from "./sqlEditorTextEdits";

describe("sqlEditorTextEdits", () => {
  it("行注释可来回切换", () => {
    expect(toggleLineComment("SELECT 1")).toBe("-- SELECT 1");
    expect(toggleLineComment("-- SELECT 1")).toBe("SELECT 1");
  });

  it("块注释包住原文，再点一次去掉", () => {
    expect(toggleBlockComment("SELECT 1")).toBe("/* SELECT 1 */");
    expect(toggleBlockComment("/* SELECT 1 */")).toBe("SELECT 1");
  });

  it("压缩空白但保留字符串", () => {
    expect(compressSql("SELECT  1\nFROM t\nWHERE name = 'a  b'")).toBe(
      "SELECT 1 FROM t WHERE name = 'a  b'",
    );
  });

  it("删除空行", () => {
    expect(deleteEmptyLines("a\n\n  \nb")).toBe("a\nb");
  });

  it("转成带引号的列表", () => {
    expect(toDelimitedList("a, b\nc")).toBe("'a', 'b', 'c'");
  });

  it("把 SELECT * 展开成列", () => {
    const next = expandSelectStar(
      "SELECT * FROM crm_receipt",
      ["id", "name"],
      (name) => quoteSqlIdent("mysql", name),
    );
    expect(next).toBe("SELECT `id`, `name` FROM crm_receipt");
  });
});