import { describe, expect, it } from "vitest";
import { stickyOffsetTops } from "./sidebarTreeStickyLayout";

describe("stickyOffsetTops", () => {
  it("子级吸在父级真实高度之下，而不是固定行高", () => {
    expect(
      stickyOffsetTops([
        { depth: 0, height: 40 },
        { depth: 1, height: 28 },
        { depth: 1, height: 28 },
        { depth: 2, height: 24 },
      ]),
    ).toEqual([0, 40, 40, 68]);
  });

  it("下一棵同级树从 0 重新累加", () => {
    expect(
      stickyOffsetTops([
        { depth: 0, height: 36 },
        { depth: 1, height: 24 },
        { depth: 0, height: 30 },
        { depth: 1, height: 24 },
      ]),
    ).toEqual([0, 36, 0, 30]);
  });
});
