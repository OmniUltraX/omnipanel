import { describe, expect, it } from "vitest";
import {
  SIDEBAR_PENDING_BACKSTOP_MS,
  shouldClearPendingOnBackstop,
} from "./sidebarPending";

describe("sidebarPending", () => {
  it("location 纹丝不动 → 兜底清除（拖拽/未导航防残留）", () => {
    window.history.replaceState(null, "", "/module/database");
    expect(shouldClearPendingOnBackstop("/module/database")).toBe(true);
  });

  it("location 已离开起点 → 不清除（导航在途中，防 B→A→B 回闪）", () => {
    window.history.replaceState(null, "", "/module/database");
    window.history.pushState(null, "", "/plugins");
    expect(shouldClearPendingOnBackstop("/module/database")).toBe(false);
    window.history.replaceState(null, "", "/module/database");
  });

  it("backstop 时长覆盖冷 chunk 的 transition 提交", () => {
    expect(SIDEBAR_PENDING_BACKSTOP_MS).toBeGreaterThanOrEqual(1000);
  });
});
