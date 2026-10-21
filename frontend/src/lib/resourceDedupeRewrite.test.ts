import { describe, expect, it } from "vitest";
import { rewriteString, rewriteValue } from "./resourceDedupeRewrite";

const from = "11111111-1111-1111-1111-111111111111";
const to = "22222222-2222-2222-2222-222222222222";
const pairs = [{ from, to }];

describe("resourceDedupeRewrite", () => {
  it("改写完整 id 和带前缀的会话键", () => {
    expect(rewriteString(from, pairs)).toBe(to);
    expect(rewriteString(`c:${from}`, pairs)).toBe(`c:${to}`);
    expect(rewriteString(`ssh-embedded-${from}`, pairs)).toBe(`ssh-embedded-${to}`);
    expect(rewriteString(`keep-${from}x`, pairs)).toBe(`keep-${from}x`);
  });

  it("键冲突时保留原来就指向保留项的值，并收拢重复顺序", () => {
    expect(
      rewriteValue(
        {
          [from]: { name: "drop" },
          [to]: { name: "keep" },
          order: [`c:${from}`, `c:${to}`, "note"],
        },
        pairs,
      ),
    ).toEqual({
      [to]: { name: "keep" },
      order: [`c:${to}`, "note"],
    });
  });

  it("不拆开终端实例", () => {
    const proto = {};
    const term = Object.assign(Object.create(proto), { id: from });
    const next = rewriteValue({ term, resourceId: from }, pairs) as {
      term: typeof term;
      resourceId: string;
    };
    expect(next.term).toBe(term);
    expect(next.resourceId).toBe(to);
  });
});
