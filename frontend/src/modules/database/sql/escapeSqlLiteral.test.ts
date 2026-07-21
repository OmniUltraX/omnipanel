import { describe, expect, it } from "vitest";
import { escapeSqlLiteral } from "./escapeSqlLiteral";

describe("escapeSqlLiteral", () => {
  it("null / undefined → NULL", () => {
    expect(escapeSqlLiteral(null)).toBe("NULL");
    expect(escapeSqlLiteral(undefined)).toBe("NULL");
  });

  it("numbers stay bare", () => {
    expect(escapeSqlLiteral(42)).toBe("42");
    expect(escapeSqlLiteral(3.14)).toBe("3.14");
  });

  it("booleans quote as true/false (legacy String behavior)", () => {
    expect(escapeSqlLiteral(true)).toBe("'true'");
    expect(escapeSqlLiteral(false)).toBe("'false'");
  });

  it("strings escape quotes and backslashes", () => {
    expect(escapeSqlLiteral("a'b")).toBe("'a\\'b'");
    expect(escapeSqlLiteral("a\\b")).toBe("'a\\\\b'");
  });

  it("JSON objects stringify instead of [object Object]", () => {
    const value = {
      comfort: "你已经足够努力。对话里「最近压力好大，工作上事情特别多」，都被温柔记录。",
      perceive:
        "我注意到你提到「最近压力好大，工作上事情特别多」——这不是软弱，是你的情绪在传递重要信号。",
      summary: "在压力中寻找喘息的你",
    };
    const lit = escapeSqlLiteral(value);
    expect(lit.startsWith("'")).toBe(true);
    expect(lit.endsWith("'")).toBe(true);
    expect(lit).not.toContain("[object Object]");
    const inner = lit.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    expect(JSON.parse(inner)).toEqual(value);
  });

  it("arrays stringify as JSON", () => {
    expect(escapeSqlLiteral([1, "a"])).toBe("'[1,\"a\"]'");
  });
});
