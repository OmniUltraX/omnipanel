import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../stores/blocksStore", () => ({
  useBlocksStore: { getState: () => ({ findBlockById: () => null }) },
  isAiThreadToolCall: () => false,
}));
vi.mock("../../../stores/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({
      terminalPassthroughAiEnter: true,
      terminalShellAgentAutocontinue: true,
    }),
  },
}));
vi.mock("../../../stores/terminalStore", () => ({
  findTerminalPane: () => null,
}));
vi.mock("../warpInlineAi", () => ({
  submitInlineNaturalLanguage: vi.fn(),
  submitInlineFollowUp: vi.fn(),
  cancelInlineAiBlock: vi.fn(),
}));
vi.mock("../inlineToolBridge", () => ({
  cancelPendingInlineTools: vi.fn(),
}));
vi.mock("../passthroughAi/enterGates", () => ({
  getEnterGateFlags: () => ({ userTyping: false }),
  patchEnterGateFlags: vi.fn(),
}));
vi.mock("../terminalPaneSenders", () => ({
  writeTerminalRaw: vi.fn(),
}));
vi.mock("../terminalShellRecovery", () => ({
  markShellPromptReady: vi.fn(),
}));
vi.mock("../terminalOutputTap", () => ({
  waitForTerminalOutputIdle: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../inlineTerminalTool", () => ({
  isInlineTerminalToolName: () => false,
}));

import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { registerXterm, unregisterXterm } from "../xtermRegistry";
import { notifyShellAgentStreaming } from "./loop";
import {
  beginShellAgentCard,
  clearShellAgentGeometry,
  getShellAgentGeometry,
} from "./shellAgentGeometry";
import { useShellAgentStore } from "./shellAgentStore";

const SID = "loop-test-session";

function createFakeTerm() {
  return {
    cols: 80,
    registerMarker() {
      return { isDisposed: false, dispose() {} } as unknown as IMarker;
    },
    registerDecoration() {
      return {
        marker: {} as IMarker,
        onRender: () => ({ dispose: () => {} }),
        dispose: () => {},
      } as unknown as IDecoration;
    },
    write(_data, cb) {
      cb?.();
    },
  };
}

describe("notifyShellAgentStreaming", () => {
  beforeEach(() => {
    useShellAgentStore.setState({ bySession: {} });
    clearShellAgentGeometry(SID);
    unregisterXterm(SID);
    registerXterm(SID, createFakeTerm() as unknown as Terminal);
  });

  it("首轮 streaming：保持 inline 卡", () => {
    useShellAgentStore.getState().ensure(SID);
    useShellAgentStore.getState().setPhase(SID, "streaming");
    beginShellAgentCard(SID, {
      kind: "thinking",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "查磁盘",
    });

    notifyShellAgentStreaming(SID);

    expect(getShellAgentGeometry(SID)?.mode).toBe("inline");
  });

  it("续轮 streaming：重锚 inline thinking 卡（非 dock）", () => {
    useShellAgentStore.getState().ensure(SID);
    useShellAgentStore.getState().setPhase(SID, "observing");

    notifyShellAgentStreaming(SID);

    const geo = getShellAgentGeometry(SID);
    expect(geo?.mode).toBe("inline");
    expect(geo?.cardKind).toBe("thinking");
    expect(geo?.decoration).not.toBeNull();
  });
});
