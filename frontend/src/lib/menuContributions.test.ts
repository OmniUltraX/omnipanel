import { describe, expect, it, vi } from "vitest";

vi.mock("./hostSelection", () => ({
  getHostSelection: vi.fn(),
}));

import { getHostSelection } from "./hostSelection";
import {
  registerMenuContribution,
  unregisterMenuContributions,
  visibleFloatContributions,
  visibleMenuContributions,
} from "./menuContributions";

const mockedSelection = vi.mocked(getHostSelection);

describe("选中悬浮按钮（float opt-in）", () => {
  it("无选区时不浮现，有选区时仅 opt-in 项浮现", () => {
    unregisterMenuContributions("omni.test.float");
    mockedSelection.mockReturnValue(null);
    registerMenuContribution({
      pluginId: "omni.test.float",
      id: "translate",
      label: "翻译",
      when: { hasSelection: true },
      float: { icon: "译" },
      onClick: () => {},
    });
    registerMenuContribution({
      pluginId: "omni.test.float",
      id: "plain",
      label: "普通项",
      onClick: () => {},
    });

    expect(visibleFloatContributions()).toEqual([]);

    mockedSelection.mockReturnValue({ text: "hello", source: "dom" });
    const floats = visibleFloatContributions();
    expect(floats.map((f) => f.id)).toEqual(["translate"]);
    expect(floats[0].selectionText).toBe("hello");
    // 右键菜单不受 float 影响：两项都可见
    expect(visibleMenuContributions().map((c) => c.id).sort()).toEqual(["plain", "translate"]);

    unregisterMenuContributions("omni.test.float");
    expect(visibleFloatContributions()).toEqual([]);
  });
});
