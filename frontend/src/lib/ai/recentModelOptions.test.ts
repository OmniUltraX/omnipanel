import { describe, expect, it } from "vitest";

import {
  RECENT_MODEL_LIMIT,
  normalizeRecentModelIds,
  rememberRecentModelIds,
  withRecentModelGroup,
} from "./recentModelOptions";

const options = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
];

describe("recentModelOptions", () => {
  it("只保留去重后的最近选择", () => {
    expect(normalizeRecentModelIds([" b ", "a", "b", 1, ""])).toEqual(["b", "a"]);
    expect(rememberRecentModelIds(["a", "b"], "b")).toEqual(["b", "a"]);
  });

  it("超过上限时丢掉最旧的", () => {
    const ids = Array.from({ length: RECENT_MODEL_LIMIT + 2 }, (_, i) => `m${i}`);
    expect(rememberRecentModelIds(ids, "fresh")).toHaveLength(RECENT_MODEL_LIMIT);
    expect(rememberRecentModelIds(ids, "fresh")[0]).toBe("fresh");
  });

  it("常用钉在顶部，下方不再重复", () => {
    const grouped = withRecentModelGroup(options, ["c", "missing", "a"], "常用");
    expect(grouped.map((opt) => opt.value)).toEqual(["c", "a", "b"]);
    expect(grouped.map((opt) => opt.group)).toEqual(["常用", "常用", undefined]);
  });

  it("没有其余模型时不挂常用标题", () => {
    const grouped = withRecentModelGroup(options.slice(0, 1), ["a"], "常用");
    expect(grouped).toEqual([{ value: "a", label: "Alpha" }]);
  });
});
