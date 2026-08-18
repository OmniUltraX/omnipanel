import { describe, expect, it, vi } from "vitest";

vi.mock("../../stores/settingsStore", () => ({
  useSettingsStore: Object.assign(
    (sel?: (s: { terminalApprovalMode: string }) => unknown) => {
      const state = { terminalApprovalMode: "always" };
      return sel ? sel(state) : state;
    },
    {
      getState: () => ({ terminalApprovalMode: "always" }),
      subscribe: () => () => {},
    },
  ),
}));
vi.mock("../../stores/terminalStore", () => ({
  findTerminalPane: () => null,
  useTerminalStore: Object.assign(() => ({ tabs: [] }), {
    getState: () => ({ tabs: [] }),
    subscribe: () => () => {},
  }),
}));
vi.mock("./aiThreadBridge", () => ({ getResolvedAiThread: () => [] }));
vi.mock("./inlineToolBridge", () => ({ getPendingInlineToolScope: () => ({}) }));
vi.mock("./terminalApprovalPolicy", () => ({ shouldRequireTerminalApproval: () => true }));
vi.mock("./terminalApprovalSettings", () => ({ resolveTerminalApprovalMode: () => "always" }));
vi.mock("../../lib/ai/toolHost", () => ({ SSH_EXEC_TOOL_NAME: "omni_ssh_exec" }));
vi.mock("../../hooks/useTerminal", () => ({ useTerminal: () => null }));

import {
  collectDisplayToolCalls,
  collectInlineTerminalToolCalls,
  hasUnshownDisplayTool,
  isDisplayShellAgentToolName,
  pickLiveStripTools,
  selectThreadForInlineTools,
} from "./inlineTerminalTool";
import type { AiThreadItem } from "../../stores/blocksStore";

describe("collectInlineTerminalToolCalls", () => {
  it("收集独立 tool_call 条目", () => {
    const thread: AiThreadItem[] = [
      {
        kind: "message",
        id: "u1",
        role: "user",
        content: "查磁盘",
        timestamp: 1,
      },
      {
        kind: "tool_call",
        id: "t1",
        toolName: "omni_ssh_exec",
        args: '{"command":"Get-PSDrive"}',
        status: "running",
        timestamp: 2,
      },
    ];
    expect(collectInlineTerminalToolCalls(thread).map((t) => t.id)).toEqual(["t1"]);
  });

  it("assistant.parts 里的 tool-call 也要捞出来", () => {
    const thread: AiThreadItem[] = [
      {
        kind: "message",
        id: "u1",
        role: "user",
        content: "查磁盘",
        timestamp: 1,
      },
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content: "",
        timestamp: 2,
        parts: [
          {
            type: "tool-call",
            id: "t-part",
            name: "omni_ssh_exec",
            arguments: '{"command":"Get-Date"}',
            status: "completed",
          },
        ],
      },
    ];
    const tools = collectInlineTerminalToolCalls(thread);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.id).toBe("t-part");
    expect(tools[0]?.status).toBe("completed");
  });

  it("独立条目优先，不与 parts 重复", () => {
    const thread: AiThreadItem[] = [
      {
        kind: "tool_call",
        id: "same",
        toolName: "omni_ssh_exec",
        args: "{}",
        status: "running",
        timestamp: 1,
      },
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content: "",
        timestamp: 2,
        parts: [
          {
            type: "tool-call",
            id: "same",
            name: "omni_ssh_exec",
            arguments: "{}",
            status: "completed",
          },
        ],
      },
    ];
    const tools = collectInlineTerminalToolCalls(thread);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.status).toBe("running");
  });

  it("独立条目缺 result 时用 part 上的输出补齐", () => {
    const thread: AiThreadItem[] = [
      {
        kind: "tool_call",
        id: "same",
        toolName: "omni_ssh_exec",
        args: '{"command":"Get-Date"}',
        command: "Get-Date",
        status: "completed",
        timestamp: 1,
      },
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content: "",
        timestamp: 2,
        parts: [
          {
            type: "tool-call",
            id: "same",
            name: "omni_ssh_exec",
            arguments: '{"command":"Get-Date"}',
            status: "completed",
            result: '{"output":"2026-08-18 08:42:14 +08:00"}',
          },
        ],
      },
    ];
    const tools = collectInlineTerminalToolCalls(thread);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.result).toContain("2026-08-18");
  });
});

describe("collectDisplayToolCalls", () => {
  it("收集 web_search，排除跑命令与 plan", () => {
    const thread: AiThreadItem[] = [
      {
        kind: "tool_call",
        id: "exec",
        toolName: "omni_ssh_exec",
        args: "{}",
        status: "completed",
        timestamp: 1,
      },
      {
        kind: "tool_call",
        id: "search",
        toolName: "omni_web_search",
        args: '{"query":"历史上的今天"}',
        status: "completed",
        timestamp: 2,
      },
      {
        kind: "tool_call",
        id: "plan",
        toolName: "omni_plan_create",
        args: "{}",
        status: "completed",
        timestamp: 3,
      },
    ];
    expect(collectDisplayToolCalls(thread).map((t) => t.id)).toEqual(["search"]);
  });

  it("跑命令不进工具条", () => {
    expect(isDisplayShellAgentToolName("omni_ssh_exec")).toBe(false);
    expect(isDisplayShellAgentToolName("omni_web_search")).toBe(true);
    expect(isDisplayShellAgentToolName("omni_web_fetch")).toBe(true);
    expect(isDisplayShellAgentToolName("omni_ask_user")).toBe(false);
  });

  it("一张条只挑一条未归档调用，多次 fetch 不会挤在一起", () => {
    const tools: AiThreadItem[] = [
      {
        kind: "tool_call",
        id: "f1",
        toolName: "omni_web_fetch",
        args: "{}",
        status: "completed",
        timestamp: 1,
      },
      {
        kind: "tool_call",
        id: "f2",
        toolName: "omni_web_fetch",
        args: "{}",
        status: "running",
        timestamp: 2,
      },
      {
        kind: "tool_call",
        id: "f3",
        toolName: "omni_web_fetch",
        args: "{}",
        status: "pending",
        timestamp: 3,
      },
    ];
    const calls = collectDisplayToolCalls(tools);
    expect(pickLiveStripTools(calls, new Set()).map((t) => t.id)).toEqual(["f1"]);
    expect(pickLiveStripTools(calls, new Set(["f1"])).map((t) => t.id)).toEqual(["f2"]);
    expect(pickLiveStripTools(calls, new Set(["f1", "f2"])).map((t) => t.id)).toEqual(["f3"]);
    expect(hasUnshownDisplayTool(calls, new Set(["f1"]), ["f2"])).toBe(true);
    expect(hasUnshownDisplayTool(calls, new Set(["f1", "f2", "f3"]), ["f3"])).toBe(false);
  });

  it("search 已出条后，已完成的 fetch 仍算未展示", () => {
    const calls = collectDisplayToolCalls([
      {
        kind: "tool_call",
        id: "search",
        toolName: "omni_web_search",
        args: "{}",
        status: "completed",
        timestamp: 1,
      },
      {
        kind: "tool_call",
        id: "fetch",
        toolName: "omni_web_fetch",
        args: "{}",
        status: "completed",
        timestamp: 2,
      },
    ]);
    expect(hasUnshownDisplayTool(calls, new Set(["search"]), ["search"])).toBe(true);
    expect(hasUnshownDisplayTool(calls, new Set(["search", "fetch"]), ["fetch"])).toBe(false);
  });
});

describe("selectThreadForInlineTools", () => {
  const thread: AiThreadItem[] = [
    { kind: "message", id: "u0", role: "user", content: "旧问题", timestamp: 1 },
    {
      kind: "tool_call",
      id: "old",
      toolName: "omni_ssh_exec",
      args: "{}",
      status: "completed",
      timestamp: 2,
    },
  ];

  it("查询未入 thread 时不回退到上一轮工具", () => {
    const turn: AiThreadItem[] = [
      {
        kind: "message",
        id: "__pending_turn__",
        role: "user",
        content: "新问题",
        timestamp: 0,
      },
    ];
    expect(selectThreadForInlineTools(thread, turn)).toBe(turn);
    expect(collectDisplayToolCalls(turn)).toEqual([]);
  });

  it("已匹配当前轮时用切片", () => {
    const turn = thread.slice(0, 1);
    expect(selectThreadForInlineTools(thread, turn)).toBe(turn);
  });
});
