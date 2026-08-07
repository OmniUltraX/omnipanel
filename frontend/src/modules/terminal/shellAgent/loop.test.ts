import { beforeEach, describe, expect, it, vi } from "vitest";

const { submitInlineFollowUp, submitInlineNaturalLanguage } = vi.hoisted(() => ({
  submitInlineFollowUp: vi.fn().mockResolvedValue(undefined),
  submitInlineNaturalLanguage: vi.fn().mockResolvedValue("block-new"),
}));

vi.mock("../../../stores/blocksStore", () => ({
  useBlocksStore: {
    getState: () => ({
      findBlockById: (id: string) =>
        id === "block-busy" ? { id, kind: "ai", status: "running" } : null,
    }),
  },
  isAiThreadToolCall: () => false,
}));
vi.mock("../../../stores/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({
      terminalPassthroughAiEnter: true,
      terminalShellAgentAutocontinue: false,
    }),
  },
}));
vi.mock("../../../stores/terminalStore", () => ({
  findTerminalPane: () => ({ cwd: "/tmp", shellLabel: "bash" }),
}));
vi.mock("../warpInlineAi", () => ({
  submitInlineNaturalLanguage,
  submitInlineFollowUp,
  cancelInlineAiBlock: vi.fn(),
}));
vi.mock("../inlineToolBridge", () => ({
  cancelPendingInlineTools: vi.fn(),
}));
vi.mock("../passthroughAi/enterGates", () => ({
  getEnterGateFlags: () => ({ userTyping: false }),
  patchEnterGateFlags: vi.fn(),
}));
vi.mock("../passthroughAi/passthroughPromptHint", () => ({
  schedulePassthroughPromptHintSync: vi.fn(),
  clearPassthroughPromptHint: vi.fn(),
  syncPassthroughPromptHint: vi.fn(),
}));
vi.mock("../terminalUiStore", () => ({
  useTerminalUiStore: {
    getState: () => ({
      getInputMode: () => "interactive",
    }),
  },
}));
vi.mock("../terminalPaneSenders", () => ({
  writeTerminalRaw: vi.fn(),
}));
vi.mock("../terminalShellRecovery", () => ({
  markShellPromptReady: vi.fn(),
  hasRecentShellPrompt: () => false,
}));
vi.mock("../terminalOutputTap", () => ({
  waitForTerminalOutputIdle: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../inlineTerminalTool", () => ({
  isInlineTerminalToolName: () => false,
}));

import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { registerXterm, unregisterXterm } from "../xtermRegistry";
import {
  notifyShellAgentStreaming,
  newShellAgentSession,
  notifyShellAgentRejected,
  startOrContinueShellAgent,
} from "./loop";
import {
  beginShellAgentCard,
  clearShellAgentGeometry,
  getShellAgentGeometry,
} from "./shellAgentGeometry";
import { useShellAgentStore } from "./shellAgentStore";
import { writeTerminalRaw } from "../terminalPaneSenders";

const SID = "loop-test-session";

function createFakeTerm() {
  const decorations: Array<{ disposed: boolean }> = [];
  return {
    cols: 80,
    decorations,
    registerMarker() {
      return { isDisposed: false, dispose() {} } as unknown as IMarker;
    },
    registerDecoration() {
      const state = { disposed: false };
      decorations.push(state);
      return {
        marker: {} as IMarker,
        onRender: () => ({ dispose: () => {} }),
        dispose: () => {
          state.disposed = true;
        },
      } as unknown as IDecoration;
    },
    write(_data: string, cb?: () => void) {
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
    submitInlineFollowUp.mockClear();
    submitInlineNaturalLanguage.mockClear();
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

  it("续轮 streaming：切到 final 卡以便解读流式出现", () => {
    useShellAgentStore.getState().ensure(SID);
    useShellAgentStore.getState().setPhase(SID, "observing");
    beginShellAgentCard(SID, {
      kind: "cmd",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "查磁盘",
    });

    notifyShellAgentStreaming(SID);

    expect(useShellAgentStore.getState().get(SID)?.phase).toBe("streaming");
    expect(getShellAgentGeometry(SID)?.cardKind).toBe("final");
  });
});

describe("startOrContinueShellAgent busy follow-up", () => {
  beforeEach(() => {
    useShellAgentStore.setState({ bySession: {} });
    clearShellAgentGeometry(SID);
    unregisterXterm(SID);
    registerXterm(SID, createFakeTerm() as unknown as Terminal);
    submitInlineFollowUp.mockClear();
    submitInlineNaturalLanguage.mockClear();
  });

  it("忙时即使 autocontinue=false 也 follow-up，不丢输入", async () => {
    useShellAgentStore.getState().ensure(SID);
    useShellAgentStore.getState().setBlockId(SID, "block-busy");
    useShellAgentStore.getState().setPhase(SID, "streaming");
    expect(useShellAgentStore.getState().isBusy(SID)).toBe(true);

    const id = await startOrContinueShellAgent(SID, "再看看内存");

    expect(id).toBe("block-busy");
    expect(submitInlineFollowUp).toHaveBeenCalledWith(
      SID,
      "block-busy",
      "再看看内存",
      "/tmp",
    );
    expect(submitInlineNaturalLanguage).not.toHaveBeenCalled();
  });

  it("锚 thinking 后 phase=streaming 但尚无 blockId：仍应新建请求，不卡死", async () => {
    useShellAgentStore.getState().ensure(SID);
    useShellAgentStore.getState().setPhase(SID, "streaming");
    expect(useShellAgentStore.getState().get(SID)?.blockId).toBeNull();
    expect(useShellAgentStore.getState().isBusy(SID)).toBe(true);

    const id = await startOrContinueShellAgent(SID, "现在的时间");

    expect(id).toBe("block-new");
    expect(submitInlineNaturalLanguage).toHaveBeenCalledWith(
      SID,
      "现在的时间",
      "/tmp",
    );
    expect(submitInlineFollowUp).not.toHaveBeenCalled();
  });

  it("cancelled 后 start 用新 thread，勿 ensure 僵尸", async () => {
    const created = useShellAgentStore.getState().ensure(SID);
    const oldThread = created.agentThreadId;
    useShellAgentStore.getState().setBlockId(SID, "zombie-block");
    useShellAgentStore.getState().bumpTurn(SID);
    useShellAgentStore.getState().cancel(SID);
    expect(useShellAgentStore.getState().get(SID)?.phase).toBe("cancelled");

    const id = await startOrContinueShellAgent(SID, "新一轮问题");

    const next = useShellAgentStore.getState().get(SID);
    expect(next?.agentThreadId).not.toBe(oldThread);
    expect(id).toBe("block-new");
    expect(submitInlineNaturalLanguage).toHaveBeenCalledWith(
      SID,
      "新一轮问题",
      "/tmp",
    );
    expect(submitInlineFollowUp).not.toHaveBeenCalled();
  });
});

describe("newShellAgentSession", () => {
  beforeEach(() => {
    useShellAgentStore.setState({ bySession: {} });
    clearShellAgentGeometry(SID);
    unregisterXterm(SID);
  });

  it("开新 thread 且保留已冻结卡 decoration", () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);

    const created = useShellAgentStore.getState().ensure(SID);
    const oldThread = created.agentThreadId;
    useShellAgentStore.getState().setBlockId(SID, "block-busy");
    useShellAgentStore.getState().setPhase(SID, "streaming");
    beginShellAgentCard(SID, {
      kind: "final",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "查时间",
    });
    expect(term.decorations).toHaveLength(1);
    expect(term.decorations[0].disposed).toBe(false);

    newShellAgentSession(SID);

    const next = useShellAgentStore.getState().get(SID);
    expect(next?.agentThreadId).not.toBe(oldThread);
    expect(next?.blockId).toBeNull();
    // 已归档卡仍挂在 scrollback，不可被 dispose
    expect(term.decorations[0].disposed).toBe(false);
    expect(getShellAgentGeometry(SID)?.decoration).toBeNull();
  });
});

describe("notifyShellAgentRejected", () => {
  beforeEach(() => {
    useShellAgentStore.setState({ bySession: {} });
    clearShellAgentGeometry(SID);
    unregisterXterm(SID);
    vi.mocked(writeTerminalRaw).mockClear();
  });

  it("拒绝后 idle 并请求 PTY 拉新 prompt，不停留在 streaming", async () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);
    useShellAgentStore.getState().ensure(SID);
    useShellAgentStore.getState().setBlockId(SID, "block-busy");
    useShellAgentStore.getState().setPhase(SID, "awaiting_approval");
    beginShellAgentCard(SID, {
      kind: "cmd",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "date",
    });

    notifyShellAgentRejected(SID);

    expect(useShellAgentStore.getState().get(SID)?.phase).toBe("idle");
    expect(getShellAgentGeometry(SID)?.decoration).toBeNull();

    // release 异步等 idle 后发 \r\n
    await vi.waitFor(() => {
      expect(writeTerminalRaw).toHaveBeenCalledWith(SID, "\r\n");
    });
  });
});
