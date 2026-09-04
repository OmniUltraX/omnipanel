import { describe, expect, it } from "vitest";
import { asPanelDashboard } from "./panelMonitorStats";

describe("asPanelDashboard", () => {
  it("直通归一化仪表盘", () => {
    expect(asPanelDashboard({ hostname: "box", cpuCores: 4 })).toMatchObject({
      hostname: "box",
      cpuCores: 4,
    });
  });

  it("解开 dashboard 包一层", () => {
    expect(asPanelDashboard({ dashboard: { hostname: "inner" } })).toEqual({ hostname: "inner" });
  });

  it("非法输入给空对象", () => {
    expect(asPanelDashboard(null)).toEqual({});
    expect(asPanelDashboard([])).toEqual({});
  });
});
