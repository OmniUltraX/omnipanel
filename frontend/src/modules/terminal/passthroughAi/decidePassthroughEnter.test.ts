import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLineBuffer } from "./lineBuffer";
import { clearEnterGateFlags, patchEnterGateFlags } from "./enterGates";

const { state } = vi.hoisted(() => ({
  state: {
    phase: null as string | null,
    passthroughAiEnter: true,
  },
}));

vi.mock("../../../stores/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({ terminalPassthroughAiEnter: state.passthroughAiEnter }),
  },
}));

vi.mock("../shellAgent/shellAgentStore", () => ({
  useShellAgentStore: {
    getState: () => ({
      isBusy: () =>
        state.phase === "streaming" ||
        state.phase === "awaiting_approval" ||
        state.phase === "executing" ||
        state.phase === "observing",
      get: () => (state.phase ? { phase: state.phase } : null),
    }),
  },
}));

import { decidePassthroughEnter } from "./decidePassthroughEnter";

const SID = "s-enter-confirm";

beforeEach(() => {
  state.phase = null;
  state.passthroughAiEnter = true;
  clearEnterGateFlags(SID);
});

afterEach(() => {
  clearEnterGateFlags(SID);
});

describe("decidePassthroughEnter approve_pending", () => {
  it("待确认且空行时回车同意", () => {
    state.phase = "awaiting_approval";
    expect(decidePassthroughEnter(SID, createLineBuffer(), "")).toEqual({
      action: "approve_pending",
    });
  });

  it("关闭 NL 分流开关时确认卡空行仍可回车同意", () => {
    state.phase = "awaiting_approval";
    state.passthroughAiEnter = false;
    expect(decidePassthroughEnter(SID, createLineBuffer(), "")).toEqual({
      action: "approve_pending",
    });
  });

  it("待确认但行上有命令时不抢确认", () => {
    state.phase = "awaiting_approval";
    expect(
      decidePassthroughEnter(SID, { text: "ls", reliable: true }, "ls"),
    ).toEqual({ action: "passthrough" });
  });

  it("待确认时光标停在蓝字问题行仍回车同意", () => {
    state.phase = "awaiting_approval";
    expect(
      decidePassthroughEnter(SID, createLineBuffer(), "现在的时间"),
    ).toEqual({ action: "approve_pending" });
  });

  it("待确认时 commandRunning 残留不阻断回车同意", () => {
    state.phase = "awaiting_approval";
    patchEnterGateFlags(SID, { commandRunning: true });
    expect(decidePassthroughEnter(SID, createLineBuffer(), "")).toEqual({
      action: "approve_pending",
    });
  });

  it("待确认时中文 NL 仍入环", () => {
    state.phase = "awaiting_approval";
    expect(
      decidePassthroughEnter(SID, { text: "现在的时间", reliable: true }),
    ).toEqual({ action: "route_ai", query: "现在的时间" });
  });

  it("Agent 执行中不拦截确认", () => {
    state.phase = "executing";
    patchEnterGateFlags(SID, { agentExecuting: true });
    expect(decidePassthroughEnter(SID, createLineBuffer(), "")).toEqual({
      action: "passthrough",
    });
  });
});
