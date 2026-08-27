import { beforeEach, describe, expect, it, vi } from "vitest";

const { submitInlineFollowUp, submitInlineNaturalLanguage, findBlockById } = vi.hoisted(() => ({
  submitInlineFollowUp: vi.fn().mockResolvedValue(undefined),
  submitInlineNaturalLanguage: vi.fn().mockResolvedValue("block-new"),
  findBlockById: vi.fn((id: string) =>
    id === "block-busy" ? { id, kind: "ai", status: "running" } : null,
  ),
}));

vi.mock("../../../stores/blocksStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../stores/blocksStore")>();
  return {
    ...actual,
    useBlocksStore: {
      getState: () => ({
        findBlockById,
      }),
    },
    isAiThreadToolCall: () => false,
  };
});
vi.mock("../../../stores/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({
      terminalPassthroughAiEnter: true,
      terminalShellAgentAutocontinue: false,
    }),
  },
}));
const { findTerminalPane } = vi.hoisted(() => ({
  findTerminalPane: vi.fn(() => ({ cwd: "/tmp", shellLabel: "bash" })),
}));
vi.mock("../../../stores/terminalStore", () => ({
  findTerminalPane,
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
  collectDisplayToolCalls: () => [],
}));

import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { registerXterm, unregisterXterm } from "../xtermRegistry";
import {
  notifyShellAgentStreaming,
  notifyShellAgentApprovalPending,
  notifyShellAgentExecuting,
  notifyShellAgentAfterDisplayTools,
  notifyShellAgentDisplayTool,
  notifyShellAgentPromoteToFinal,
  notifyShellAgentTurnFinished,
  newShellAgentSession,
  notifyShellAgentRejected,
  startOrContinueShellAgent,
  teardownShellAgentUi,
} from "./loop";
import {
  beginShellAgentCard,
  clearShellAgentGeometry,
  getShellAgentGeometry,
} from "./shellAgentGeometry";
import { useShellAgentStore } from "./shellAgentStore";
import {
  getLastFrozenThinking,
  rememberFrozenThinking,
  setShellAgentLastCmd,
  setShellAgentThinkingFull,
} from "./thinkingCache";
import { writeTerminalRaw } from "../terminalPaneSenders";

const SID = "loop-test-session";

function createFakeTerm(opts?: { cursorY?: number; promptLine?: string }) {
  const decorations: Array<{ disposed: boolean }> = [];
  let markerLine = 0;
  const cursorY = opts?.cursorY ?? 20;
  const promptLine = opts?.promptLine ?? "$ ";
  const lines: Record<number, string> = {
    [cursorY]: promptLine,
    [cursorY - 1]: "df -h",
    [cursorY - 2]: "Filesystem Size",
  };
  return {
    cols: 80,
    rows: 40,
    decorations,
    buffer: {
      active: {
        baseY: 0,
        get cursorY() {
          return cursorY;
        },
        length: cursorY + 5,
        getLine(y: number) {
          const text = lines[y] ?? "";
          return { translateToString: () => text };
        },
      },
    },
    registerMarker(offset = 0) {
      const line = markerLine + offset;
      markerLine += 1;
      return {
        isDisposed: false,
        line,
        dispose() {},
      } as unknown as IMarker;
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
    teardownShellAgentUi(SID);
    useShellAgentStore.setState({ bySession: {} });
    clearShellAgentGeometry(SID);
    unregisterXterm(SID);
    registerXterm(SID, createFakeTerm() as unknown as Terminal);
    submitInlineFollowUp.mockClear();
    submitInlineNaturalLanguage.mockClear();
    findBlockById.mockImplementation((id: string) =>
      id === "block-busy" ? { id, kind: "ai", status: "running" } : null,
    );
    findTerminalPane.mockReturnValue({ cwd: "/tmp", shellLabel: "bash" });
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

  it("续轮 streaming：等 settle 后钉思考卡，避免空结果卡盖住输出", async () => {
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
    await vi.waitFor(() => {
      expect(getShellAgentGeometry(SID)?.cardKind).toBe("thinking");
    });
  });

  it("执行中 streaming 不钉思考卡，避免盖住回显", async () => {
    useShellAgentStore.getState().ensure(SID);
    beginShellAgentCard(SID, {
      kind: "cmd",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "查磁盘",
    });

    notifyShellAgentExecuting(SID, true);
    notifyShellAgentStreaming(SID);

    expect(useShellAgentStore.getState().get(SID)?.phase).toBe("executing");
    await new Promise((r) => setTimeout(r, 80));
    expect(getShellAgentGeometry(SID)?.cardKind).not.toBe("thinking");
  });

  it("跑命令同意后归档确认卡，不另钉工具条槽", () => {
    findTerminalPane.mockReturnValue({ cwd: "/tmp", shellLabel: "PowerShell" });
    useShellAgentStore.getState().ensure(SID);
    beginShellAgentCard(SID, {
      kind: "cmd",
      promptIndentCols: 2,
      promptPrefix: "PS> ",
      query: "查磁盘",
    });

    notifyShellAgentExecuting(SID, true);

    const geo = getShellAgentGeometry(SID);
    expect(geo?.cardKind).not.toBe("cmd");
    expect(useShellAgentStore.getState().get(SID)?.phase).toBe("executing");
  });

  it("执行开始时把思考卡冻成已同意确认卡，不拆卡", () => {
    useShellAgentStore.getState().ensure(SID);
    beginShellAgentCard(SID, {
      kind: "thinking",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "查磁盘",
    });
    setShellAgentLastCmd(SID, { command: "date", toolId: "t-date" });

    notifyShellAgentExecuting(SID, true);

    expect(getShellAgentGeometry(SID)?.cardKind).not.toBe("thinking");
    expect(useShellAgentStore.getState().get(SID)?.phase).toBe("executing");
  });
});

describe("startOrContinueShellAgent busy follow-up", () => {
  beforeEach(() => {
    teardownShellAgentUi(SID);
    useShellAgentStore.setState({ bySession: {} });
    clearShellAgentGeometry(SID);
    unregisterXterm(SID);
    registerXterm(SID, createFakeTerm() as unknown as Terminal);
    submitInlineFollowUp.mockClear();
    submitInlineNaturalLanguage.mockClear();
    findBlockById.mockImplementation((id: string) =>
      id === "block-busy" ? { id, kind: "ai", status: "running" } : null,
    );
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
    teardownShellAgentUi(SID);
    useShellAgentStore.setState({ bySession: {} });
    clearShellAgentGeometry(SID);
    unregisterXterm(SID);
    findBlockById.mockImplementation((id: string) =>
      id === "block-busy" ? { id, kind: "ai", status: "running" } : null,
    );
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

describe("notifyShellAgentApprovalPending", () => {
  beforeEach(() => {
    teardownShellAgentUi(SID);
    useShellAgentStore.setState({ bySession: {} });
    clearShellAgentGeometry(SID);
    unregisterXterm(SID);
    findBlockById.mockImplementation((id: string) =>
      id === "block-busy" ? { id, kind: "ai", status: "running" } : null,
    );
  });

  it("从结果卡切到下一确认卡时归档另钉，不把结果卡同槽换肤", () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);
    useShellAgentStore.getState().ensure(SID);
    useShellAgentStore.getState().setPhase(SID, "streaming");
    beginShellAgentCard(SID, {
      kind: "final",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "查资源",
    });
    expect(term.decorations).toHaveLength(1);

    notifyShellAgentApprovalPending(SID);

    expect(useShellAgentStore.getState().get(SID)?.phase).toBe("awaiting_approval");
    expect(getShellAgentGeometry(SID)?.cardKind).toBe("cmd");
    expect(term.decorations.length).toBeGreaterThanOrEqual(2);
    expect(term.decorations[0].disposed).toBe(false);
  });

  it("续轮思考卡钉在确认位后，下一工具先等思考正文，不立刻切确认卡", async () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);
    useShellAgentStore.getState().ensure(SID);
    useShellAgentStore.getState().setPhase(SID, "observing");
    beginShellAgentCard(SID, {
      kind: "cmd",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "查资源",
    });

    notifyShellAgentStreaming(SID);
    await vi.waitFor(() => {
      expect(getShellAgentGeometry(SID)?.cardKind).toBe("thinking");
    });

    notifyShellAgentApprovalPending(SID);

    expect(getShellAgentGeometry(SID)?.cardKind).toBe("thinking");
    expect(useShellAgentStore.getState().get(SID)?.phase).not.toBe("awaiting_approval");
  });

  it("命令输出未落定前下一确认卡延后，不立刻切 awaiting_approval", () => {
    const term = createFakeTerm();
    registerXterm(SID, term as unknown as Terminal);
    useShellAgentStore.getState().ensure(SID);
    beginShellAgentCard(SID, {
      kind: "cmd",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "查资源",
    });
    notifyShellAgentExecuting(SID, true);

    notifyShellAgentApprovalPending(SID);

    expect(useShellAgentStore.getState().get(SID)?.phase).toBe("executing");
  });
});

describe("notifyShellAgentRejected", () => {
  beforeEach(() => {
    teardownShellAgentUi(SID);
    useShellAgentStore.setState({ bySession: {} });
    clearShellAgentGeometry(SID);
    unregisterXterm(SID);
    vi.mocked(writeTerminalRaw).mockClear();
    findBlockById.mockImplementation((id: string) =>
      id === "block-busy" ? { id, kind: "ai", status: "running" } : null,
    );
  });

  it("拒绝后 idle 并请求 PTY 拉新 prompt，不停留在 streaming", async () => {
    // 光标不在空 prompt 上，release 才会发 \n 拉新行
    const term = createFakeTerm({ cursorY: 5, promptLine: "" });
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

    // release 异步等 idle 后发 \n
    await vi.waitFor(() => {
      expect(writeTerminalRaw).toHaveBeenCalledWith(SID, "\n");
    });
  });
});

describe("notifyShellAgentAfterDisplayTools", () => {
  beforeEach(() => {
    teardownShellAgentUi(SID);
    useShellAgentStore.setState({ bySession: {} });
    clearShellAgentGeometry(SID);
    unregisterXterm(SID);
    registerXterm(SID, createFakeTerm() as unknown as Terminal);
    findBlockById.mockImplementation((id: string) =>
      id === "block-busy" ? { id, kind: "ai", status: "running" } : null,
    );
  });

  it("无新思考时留在工具条接下一条，不等 PTY settle", () => {
    useShellAgentStore.getState().ensure(SID);
    useShellAgentStore.getState().setPhase(SID, "streaming");
    beginShellAgentCard(SID, {
      kind: "cmd",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "历史上的今天",
    });

    notifyShellAgentAfterDisplayTools(SID);

    expect(getShellAgentGeometry(SID)?.cardKind).toBe("cmd");
    expect(useShellAgentStore.getState().get(SID)?.phase).toBe("observing");
  });

  it("search 等展示工具条按 2 行钉，不按确认卡 6 行占位", () => {
    useShellAgentStore.getState().ensure(SID);
    useShellAgentStore.getState().setPhase(SID, "streaming");
    beginShellAgentCard(SID, {
      kind: "thinking",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "历史上的今天",
    });
    setShellAgentThinkingFull(SID, "先 search 再 fetch 历史上的今天");

    notifyShellAgentDisplayTool(SID);

    expect(getShellAgentGeometry(SID)?.cardKind).toBe("cmd");
    expect(getShellAgentGeometry(SID)?.rows).toBe(2);
  });

  it("思考卡还是空占位时不钉工具条，避免冻成正在理解意图", () => {
    useShellAgentStore.getState().ensure(SID);
    useShellAgentStore.getState().setPhase(SID, "streaming");
    beginShellAgentCard(SID, {
      kind: "thinking",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "历史上的今天",
    });

    notifyShellAgentDisplayTool(SID);

    expect(getShellAgentGeometry(SID)?.cardKind).toBe("thinking");
  });

  it("思考卡在轮次结束时直接收官，不停留在 observing 转圈", async () => {
    useShellAgentStore.getState().ensure(SID);
    useShellAgentStore.getState().setPhase(SID, "observing");
    beginShellAgentCard(SID, {
      kind: "thinking",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "历史上的今天",
    });

    notifyShellAgentTurnFinished(SID);

    expect(getShellAgentGeometry(SID)?.cardKind).toBe("thinking");
    await vi.waitFor(() => {
      expect(useShellAgentStore.getState().get(SID)?.phase).toBe("idle");
    });
  });

  it("工具后仍是已冻旧思考时不重复钉思考卡", () => {
    findBlockById.mockImplementation((id: string) =>
      id === "block-busy"
        ? {
            id,
            kind: "ai",
            status: "running",
            aiThread: [
              {
                kind: "message",
                id: "u1",
                role: "user",
                content: "历史上的今天",
                timestamp: 1,
              },
              {
                kind: "message",
                id: "a1",
                role: "assistant",
                content: "",
                timestamp: 1,
                parts: [
                  { type: "reasoning", text: "先查今天日期，再搜索" },
                  {
                    type: "tool-call",
                    id: "t-search",
                    name: "omni_web_search",
                    arguments: "{}",
                    status: "completed",
                  },
                  { type: "reasoning", text: "先查今天日期，再搜索" },
                ],
              },
              {
                kind: "tool_call",
                id: "t-search",
                toolName: "omni_web_search",
                args: "{}",
                status: "completed",
                timestamp: 1,
              },
            ],
          }
        : null,
    );
    useShellAgentStore.getState().ensure(SID);
    useShellAgentStore.getState().setBlockId(SID, "block-busy");
    useShellAgentStore.getState().setPhase(SID, "streaming");
    beginShellAgentCard(SID, {
      kind: "cmd",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "历史上的今天",
    });
    rememberFrozenThinking(SID, "先查今天日期，再搜索");

    notifyShellAgentAfterDisplayTools(SID);

    expect(getShellAgentGeometry(SID)?.cardKind).toBe("cmd");
  });

  it("有新思考窗口时不把空思考槽就地改成工具条", () => {
    findBlockById.mockImplementation((id: string) =>
      id === "block-busy"
        ? {
            id,
            kind: "ai",
            status: "running",
            aiThread: [
              {
                kind: "message",
                id: "u1",
                role: "user",
                content: "历史上的今天",
                timestamp: 1,
              },
              {
                kind: "message",
                id: "a1",
                role: "assistant",
                content: "",
                timestamp: 1,
                parts: [
                  { type: "reasoning", text: "搜索结果已经返回，接下来 fetch" },
                ],
              },
            ],
          }
        : null,
    );
    useShellAgentStore.getState().ensure(SID);
    useShellAgentStore.getState().setBlockId(SID, "block-busy");
    useShellAgentStore.getState().setPhase(SID, "streaming");
    beginShellAgentCard(SID, {
      kind: "thinking",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "历史上的今天",
    });
    rememberFrozenThinking(SID, "先查今天日期，再搜索");

    const pinned = notifyShellAgentDisplayTool(SID);

    expect(pinned).toBe(false);
    expect(getShellAgentGeometry(SID)?.cardKind).toBe("thinking");
  });

  it("已在思考卡上时 afterDisplayTools 不再重钉", () => {
    findBlockById.mockImplementation((id: string) =>
      id === "block-busy"
        ? {
            id,
            kind: "ai",
            status: "running",
            aiThread: [
              {
                kind: "message",
                id: "u1",
                role: "user",
                content: "历史上的今天",
                timestamp: 1,
              },
              {
                kind: "message",
                id: "a1",
                role: "assistant",
                content: "",
                timestamp: 1,
                parts: [
                  { type: "reasoning", text: "搜索结果已经返回，接下来 fetch" },
                ],
              },
            ],
          }
        : null,
    );
    useShellAgentStore.getState().ensure(SID);
    useShellAgentStore.getState().setBlockId(SID, "block-busy");
    useShellAgentStore.getState().setPhase(SID, "streaming");
    beginShellAgentCard(SID, {
      kind: "thinking",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "历史上的今天",
    });
    const before = getShellAgentGeometry(SID);

    notifyShellAgentAfterDisplayTools(SID);

    expect(getShellAgentGeometry(SID)?.cardKind).toBe("thinking");
    expect(getShellAgentGeometry(SID)?.version).toBe(before?.version);
  });

  it("刚从工具条钉上思考卡时 displayTool 不得立刻改回工具条", () => {
    findBlockById.mockImplementation((id: string) =>
      id === "block-busy"
        ? {
            id,
            kind: "ai",
            status: "running",
            aiThread: [
              {
                kind: "message",
                id: "u1",
                role: "user",
                content: "历史上的今天",
                timestamp: 1,
              },
              {
                kind: "message",
                id: "a1",
                role: "assistant",
                content: "",
                timestamp: 1,
                parts: [
                  { type: "reasoning", text: "搜索结果已经返回，接下来 fetch" },
                ],
              },
            ],
          }
        : null,
    );
    useShellAgentStore.getState().ensure(SID);
    useShellAgentStore.getState().setBlockId(SID, "block-busy");
    useShellAgentStore.getState().setPhase(SID, "streaming");
    beginShellAgentCard(SID, {
      kind: "cmd",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "历史上的今天",
    });
    const deco = getShellAgentGeometry(SID)?.decoration as {
      element?: { innerHTML: string; querySelector: () => null };
    } | undefined;
    if (deco) {
      deco.element = {
        innerHTML: '<div class="term-shell-agent-tool" data-tool-id="t-search"></div>',
        querySelector: () => null,
      };
    }

    notifyShellAgentAfterDisplayTools(SID);
    expect(getShellAgentGeometry(SID)?.cardKind).toBe("thinking");

    const flipped = notifyShellAgentDisplayTool(SID);
    expect(flipped).toBe(false);
    expect(getShellAgentGeometry(SID)?.cardKind).toBe("thinking");

    setShellAgentThinkingFull(SID, "搜索结果已经返回，接下来 fetch");
    const flippedAfterPaint = notifyShellAgentDisplayTool(SID);
    expect(flippedAfterPaint).toBe(false);
    expect(getShellAgentGeometry(SID)?.cardKind).toBe("thinking");
  });

  it("最后一轮思考卡归档另钉结果卡，不同槽换肤", () => {
    const term = createFakeTerm();
    unregisterXterm(SID);
    registerXterm(SID, term as unknown as Terminal);
    useShellAgentStore.getState().ensure(SID);
    useShellAgentStore.getState().setPhase(SID, "streaming");
    beginShellAgentCard(SID, {
      kind: "thinking",
      promptIndentCols: 2,
      promptPrefix: "$ ",
      query: "历史上的今天",
    });
    setShellAgentThinkingFull(SID, "搜索和抓取都齐了，开始写长文");

    notifyShellAgentPromoteToFinal(SID);

    expect(getShellAgentGeometry(SID)?.cardKind).toBe("final");
    expect(getLastFrozenThinking(SID)).toBe("搜索和抓取都齐了，开始写长文");
    expect(term.decorations.length).toBeGreaterThanOrEqual(2);
    expect(term.decorations[0].disposed).toBe(false);
  });
});
