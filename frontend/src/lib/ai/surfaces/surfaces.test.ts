import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDashboardSuggestionChips } from "./suggestionChips";

const openDrawer = vi.fn();
const createConversation = vi.fn(() => "conv-1");
const setConversationAgentId = vi.fn();
const sendToAiDock = vi.fn().mockResolvedValue(undefined);

vi.mock("../../../stores/aiStore", () => ({
  useAiStore: {
    getState: () => ({
      openDrawer,
      createConversation,
      setConversationAgentId,
      activeConversationId: "conv-1",
    }),
  },
}));

vi.mock("../sendToAiDock", () => ({
  sendToAiDock: (...args: unknown[]) => sendToAiDock(...args),
}));

import { askAiFromSurface } from "./askAiFromSurface";

describe("buildDashboardSuggestionChips", () => {
  it("合并草稿/任务/Finding 并尊重上限", () => {
    const chips = buildDashboardSuggestionChips({
      limit: 3,
      drafts: [{ id: "d1", title: "删库草稿" }],
      tasks: [
        { id: "t1", name: "导出任务", info: "running" },
        { id: "t2", name: "同步" },
      ],
      findings: [{ id: "f1", title: "磁盘告警", summary: "80%" }],
    });
    expect(chips).toHaveLength(3);
    expect(chips[0]?.kind).toBe("draft");
    expect(chips[1]?.kind).toBe("task");
    expect(chips[2]?.kind).toBe("task");
    expect(chips[0]?.prompt).toContain("删库草稿");
  });

  it("空上下文时使用 starter 兜底", () => {
    const chips = buildDashboardSuggestionChips({
      starters: [{ id: "a", label: "总览", prompt: "请总览" }],
    });
    expect(chips).toHaveLength(1);
    expect(chips[0]?.kind).toBe("starter");
    expect(chips[0]?.prompt).toBe("请总览");
  });

  it("空输入返回空数组", () => {
    expect(buildDashboardSuggestionChips({})).toEqual([]);
  });
});

describe("askAiFromSurface", () => {
  beforeEach(() => {
    openDrawer.mockClear();
    createConversation.mockClear();
    setConversationAgentId.mockClear();
    sendToAiDock.mockClear();
  });

  it("空 prompt 不发送", async () => {
    await askAiFromSurface({ prompt: "  ", surface: "dashboard" });
    expect(sendToAiDock).not.toHaveBeenCalled();
  });

  it("dashboard 默认新会话 + run Agent", async () => {
    await askAiFromSurface({ prompt: "帮我看看首页", surface: "dashboard" });
    expect(openDrawer).toHaveBeenCalled();
    expect(createConversation).toHaveBeenCalledWith(undefined, undefined, {
      agentId: "run",
    });
    expect(setConversationAgentId).toHaveBeenCalledWith("conv-1", "run");
    expect(sendToAiDock).toHaveBeenCalledWith(
      "帮我看看首页",
      expect.objectContaining({ newConversation: false }),
    );
  });

  it("module 绑定对应 Agent", async () => {
    await askAiFromSurface({
      prompt: "检查容器",
      surface: "module",
      moduleKey: "docker",
    });
    expect(createConversation).toHaveBeenCalledWith(undefined, undefined, {
      agentId: "docker",
    });
    expect(setConversationAgentId).toHaveBeenCalledWith("conv-1", "docker");
  });
});
