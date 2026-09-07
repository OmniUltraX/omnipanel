import { describe, expect, it } from "vitest";
import {
  recordRouteSwitch,
  resetSwitchPerf,
  switchPerfSummary,
} from "./moduleSwitchPerf";

describe("moduleSwitchPerf", () => {
  it("记录切换样本并按路由对聚合", async () => {
    resetSwitchPerf();
    if (typeof requestAnimationFrame !== "function") return;
    recordRouteSwitch("/module/terminal", "/module/database");
    recordRouteSwitch("/module/terminal", "/module/database");
    await new Promise((r) => setTimeout(r, 50));
    const summary = switchPerfSummary();
    expect(summary).toHaveLength(1);
    expect(summary[0].pair).toBe("/module/terminal → /module/database");
    expect(summary[0].count).toBe(2);
    expect(summary[0].avgMs).toBeGreaterThanOrEqual(0);
    resetSwitchPerf();
    expect(switchPerfSummary()).toEqual([]);
  });

  it("同路由不记录", async () => {
    resetSwitchPerf();
    if (typeof requestAnimationFrame !== "function") return;
    recordRouteSwitch("/module/terminal", "/module/terminal");
    await new Promise((r) => setTimeout(r, 50));
    expect(switchPerfSummary()).toEqual([]);
  });
});
