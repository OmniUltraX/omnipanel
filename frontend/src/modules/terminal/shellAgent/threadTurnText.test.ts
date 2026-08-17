import { describe, expect, it } from "vitest";
import type { AiThreadItem, AiThreadMessage, AiThreadToolCall } from "../../../stores/blocksStore";
import {
  assistantNoteForTool,
  currentTurnAssistant,
  currentTurnInterpretation,
  currentTurnResultText,
  currentTurnThinkingText,
  isPendingTurnThread,
  isToolBoundaryLeftover,
  scopeThreadToQuery,
  toolBoundaryLeftoverFragment,
  toolHasPriorInTurn,
} from "./threadTurnText";

function user(id: string, content: string): AiThreadMessage {
  return { kind: "message", id, role: "user", content, timestamp: 1 };
}

function assistant(id: string, content: string): AiThreadMessage {
  return { kind: "message", id, role: "assistant", content, timestamp: 1 };
}

function tool(id: string, command: string): AiThreadToolCall {
  return {
    kind: "tool_call",
    id,
    toolName: "run_terminal_command",
    args: JSON.stringify({ command }),
    command,
    status: "pending",
    timestamp: 1,
  };
}

describe("threadTurnText", () => {
  const thread: AiThreadItem[] = [
    user("u1", "现在的时间"),
    assistant("a1", "当前时间是：2026年8月14日 15:51:30"),
    { ...tool("t1", "Get-Date"), status: "completed" },
    user("u2", "看一下资源占用"),
    assistant("a2", "接下来读取系统内存与 CPU。"),
    tool("t2", "systeminfo"),
  ];

  it("确认卡旁注只用本轮工具前的助手正文", () => {
    expect(assistantNoteForTool(thread, "t2")).toBe("接下来读取系统内存与 CPU。");
    expect(assistantNoteForTool(thread, "t2")).not.toContain("15:51:30");
  });

  it("本轮尚无新助手正文时不为确认卡复用上一轮", () => {
    const noPreamble: AiThreadItem[] = [
      user("u1", "现在的时间"),
      assistant("a1", "当前时间是：2026年8月14日 15:51:30"),
      user("u2", "看一下资源占用"),
      tool("t2", "systeminfo"),
    ];
    expect(assistantNoteForTool(noPreamble, "t2")).toBe("");
    expect(currentTurnAssistant(noPreamble)).toBe("");
  });

  it("结果卡解读只用最后一个工具之后的正文", () => {
    const withInterpret: AiThreadItem[] = [
      ...thread.slice(0, -1),
      { ...tool("t2", "systeminfo"), status: "completed" },
      assistant("a3", "内存占用约 16GB，CPU 正常。"),
    ];
    expect(currentTurnInterpretation(withInterpret)).toBe("内存占用约 16GB，CPU 正常。");
    expect(currentTurnInterpretation(withInterpret)).not.toContain("15:51:30");
  });

  it("同一条 assistant 的 parts 按工具切段，不把第一段正文复用到后续卡", () => {
    const sameMsg: AiThreadItem[] = [
      user("u1", "现在的时间"),
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content:
          "当前时间是：2026年8月14日 15:51:30\n接下来采样 CPU。\nCPU 约 12%，内存充足。",
        parts: [
          { type: "text", text: "当前时间是：2026年8月14日 15:51:30" },
          {
            type: "tool-call",
            id: "t1",
            name: "run_terminal_command",
            arguments: "{}",
            status: "completed",
          },
          { type: "text", text: "接下来采样 CPU。" },
          {
            type: "tool-call",
            id: "t2",
            name: "run_terminal_command",
            arguments: "{}",
            status: "pending",
          },
          { type: "text", text: "CPU 约 12%，内存充足。" },
        ],
        timestamp: 1,
      },
      { ...tool("t1", "Get-Date"), status: "completed" },
      tool("t2", "Get-Counter"),
    ];
    expect(assistantNoteForTool(sameMsg, "t1")).toBe("当前时间是：2026年8月14日 15:51:30");
    expect(assistantNoteForTool(sameMsg, "t2")).toBe("接下来采样 CPU。");
    expect(assistantNoteForTool(sameMsg, "t2")).not.toContain("15:51:30");
    expect(currentTurnInterpretation(sameMsg)).toBe("CPU 约 12%，内存充足。");
    expect(currentTurnInterpretation(sameMsg)).not.toContain("15:51:30");
    expect(currentTurnAssistant(sameMsg)).toBe("CPU 约 12%，内存充足。");
  });

  it("下一工具已 pending 时结果卡仍展示上一工具之后的正文", () => {
    const sameMsg: AiThreadItem[] = [
      user("u2", "看一下资源占用"),
      {
        kind: "message",
        id: "a2",
        role: "assistant",
        content: "接下来采样 CPU。\nCPU 约 12%。",
        parts: [
          { type: "text", text: "接下来采样 CPU。" },
          {
            type: "tool-call",
            id: "t1",
            name: "run_terminal_command",
            arguments: "{}",
            status: "completed",
          },
          { type: "text", text: "CPU 约 12%。" },
          {
            type: "tool-call",
            id: "t2",
            name: "run_terminal_command",
            arguments: "{}",
            status: "pending",
          },
        ],
        timestamp: 1,
      },
      { ...tool("t1", "Get-Counter"), status: "completed" },
      tool("t2", "Get-Process"),
    ];
    expect(currentTurnResultText(sameMsg)).toBe("CPU 约 12%。");
    expect(toolHasPriorInTurn(sameMsg, "t2")).toBe(true);
    expect(toolHasPriorInTurn(sameMsg, "t1")).toBe(false);
  });

  it("待确认工具后的思考尾巴不能盖住工具前的全文", () => {
    const thread: AiThreadItem[] = [
      user("u1", "现在的时间"),
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content: "",
        parts: [
          { type: "reasoning", text: "用户问现在的时间。我需要用 Get-Date。" },
          {
            type: "tool-call",
            id: "t1",
            name: "run_terminal_command",
            arguments: "{}",
            status: "pending",
          },
          { type: "reasoning", text: "ni_ssh_exec." },
        ],
        timestamp: 1,
      },
      tool("t1", "Get-Date"),
    ];
    const text = currentTurnThinkingText(thread);
    expect(text).toContain("用户问现在的时间");
    expect(text).toContain("Get-Date");
    expect(text).not.toBe("ni_ssh_exec.");
  });

  it("思考卡正文合并本窗口 reasoning 碎片，不只最后一句", () => {
    const thread: AiThreadItem[] = [
      user("u1", "看一下资源占用"),
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content: "",
        parts: [
          { type: "reasoning", text: "用户想查看资源占用。" },
          { type: "text", text: "先" },
          { type: "reasoning", text: "采样 CPU 与内存。" },
          {
            type: "tool-call",
            id: "t1",
            name: "run_terminal_command",
            arguments: "{}",
            status: "pending",
          },
        ],
        timestamp: 1,
      },
      tool("t1", "Get-Counter"),
    ];
    const text = currentTurnThinkingText(thread);
    expect(text).toContain("用户想查看资源占用");
    expect(text).toContain("采样 CPU 与内存");
  });

  it("后续思考窗口不含上一工具前的思考", () => {
    const thread: AiThreadItem[] = [
      user("u1", "看一下资源占用"),
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content: "",
        parts: [
          { type: "reasoning", text: "先看 CPU。" },
          {
            type: "tool-call",
            id: "t1",
            name: "run_terminal_command",
            arguments: "{}",
            status: "completed",
          },
          { type: "reasoning", text: "CPU 正常，" },
          { type: "text", text: "接着" },
          { type: "reasoning", text: "再看内存。" },
          {
            type: "tool-call",
            id: "t2",
            name: "run_terminal_command",
            arguments: "{}",
            status: "pending",
          },
        ],
        timestamp: 1,
      },
      { ...tool("t1", "Get-Counter"), status: "completed" },
      tool("t2", "Get-Process"),
    ];
    const text = currentTurnThinkingText(thread);
    expect(text).toContain("CPU 正常");
    expect(text).toContain("再看内存");
    expect(text).not.toContain("先看 CPU");
  });

  it("下一工具已 pending 但窗口尚无新思考时，确认位思考卡为空", () => {
    const thread: AiThreadItem[] = [
      user("u1", "看一下资源占用"),
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content: "",
        parts: [
          { type: "reasoning", text: "先看 CPU。" },
          {
            type: "tool-call",
            id: "t1",
            name: "run_terminal_command",
            arguments: "{}",
            status: "completed",
          },
          {
            type: "tool-call",
            id: "t2",
            name: "run_terminal_command",
            arguments: "{}",
            status: "pending",
          },
        ],
        timestamp: 1,
      },
      { ...tool("t1", "Get-Counter"), status: "completed" },
      tool("t2", "Get-Process"),
    ];
    expect(currentTurnThinkingText(thread)).toBe("");
    expect(currentTurnThinkingText(thread)).not.toContain("先看 CPU");
  });

  it("工具已完成后若无新 token，思考卡为空，不回退上一窗口", () => {
    const thread: AiThreadItem[] = [
      user("u1", "看一下资源占用"),
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content: "",
        parts: [
          { type: "reasoning", text: "先看 CPU。" },
          {
            type: "tool-call",
            id: "t1",
            name: "run_terminal_command",
            arguments: "{}",
            status: "completed",
          },
        ],
        timestamp: 1,
      },
      { ...tool("t1", "Get-Counter"), status: "completed" },
    ];
    expect(currentTurnThinkingText(thread)).toBe("");
  });

  it("工具完成后，思考最后一行尾巴不能进结果卡 / 新思考卡", () => {
    const thread: AiThreadItem[] = [
      user("u1", "现在的时间"),
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "reasoning",
            text: "The user wants the current time. I'll get the time from the local terminal.",
          },
          {
            type: "tool-call",
            id: "t1",
            name: "run_terminal_command",
            arguments: "{}",
            status: "completed",
          },
          { type: "reasoning", text: "time from the local terminal." },
        ],
        timestamp: 1,
      },
      { ...tool("t1", "Get-Date"), status: "completed" },
    ];
    expect(currentTurnThinkingText(thread)).toBe("");
    expect(currentTurnInterpretation(thread)).toBe("");
    expect(currentTurnResultText(thread)).toBe("");
    expect(isToolBoundaryLeftover(
      "The user wants the current time. I'll get the time from the local terminal.",
      "time from the local terminal.",
    )).toBe(true);
  });

  it("工具完成后的真正解读仍进结果卡，不被当成思考尾巴丢掉", () => {
    const thread: AiThreadItem[] = [
      user("u1", "现在的时间"),
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "reasoning",
            text: "The user wants the current time. I'll get the time from the local terminal.",
          },
          {
            type: "tool-call",
            id: "t1",
            name: "run_terminal_command",
            arguments: "{}",
            status: "completed",
          },
          { type: "reasoning", text: "time from the local terminal." },
          {
            type: "text",
            text: "当前时间为：2026-08-17 10:30:33 (星期一)，时区 +08:00。",
          },
        ],
        timestamp: 1,
      },
      { ...tool("t1", "Get-Date"), status: "completed" },
    ];
    expect(currentTurnThinkingText(thread)).toBe("");
    expect(currentTurnResultText(thread)).toContain("当前时间为");
    expect(currentTurnResultText(thread)).not.toContain("local terminal");
  });

  it("新问题尚未写入 thread 时不读上一轮思考", () => {
    const thread: AiThreadItem[] = [
      user("u1", "现在的时间"),
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content: "",
        reasoning: "用户问现在的时间。我需要用 Get-Date。",
        parts: [{ type: "reasoning", text: "用户问现在的时间。我需要用 Get-Date。" }],
        timestamp: 1,
      },
    ];
    const scoped = scopeThreadToQuery(thread, "看一下资源占用，分步执行");
    expect(isPendingTurnThread(scoped)).toBe(true);
    expect(currentTurnThinkingText(scoped)).toBe("");
    expect(currentTurnThinkingText(scoped)).not.toContain("Get-Date");
  });

  it("同一 thread 第二轮只读本轮思考", () => {
    const thread: AiThreadItem[] = [
      user("u1", "现在的时间"),
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content: "",
        parts: [{ type: "reasoning", text: "用户问现在的时间。" }],
        timestamp: 1,
      },
      user("u2", "看一下资源占用，分步执行"),
      {
        kind: "message",
        id: "a2",
        role: "assistant",
        content: "",
        parts: [{ type: "reasoning", text: "用户要看资源占用，分步执行。" }],
        timestamp: 2,
      },
    ];
    const scoped = scopeThreadToQuery(thread, "看一下资源占用，分步执行");
    const text = currentTurnThinkingText(scoped);
    expect(text).toContain("资源占用");
    expect(text).not.toContain("现在的时间");
  });

  it("工具后重放的整段推理只保留新增后缀，不把工具前思考再贴到后一张卡", () => {
    const pre =
      "用户要求查一下历史上的今天。当前本地日期是 2026-08-17。";
    const thread: AiThreadItem[] = [
      user("u1", "网络查一下历史上的今天"),
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content: "",
        parts: [
          { type: "reasoning", text: pre },
          {
            type: "tool-call",
            id: "t-search",
            name: "omni_web_search",
            arguments: "{}",
            status: "completed",
          },
          {
            type: "reasoning",
            text: `${pre}我已经用 omni_web_search 获取了相关搜索结果。`,
          },
        ],
        timestamp: 1,
      },
      {
        kind: "tool_call",
        id: "t-search",
        toolName: "omni_web_search",
        args: "{}",
        status: "completed",
        timestamp: 1,
      },
    ];
    const text = currentTurnThinkingText(thread);
    expect(text).toContain("我已经用 omni_web_search");
    expect(text).not.toContain("当前本地日期");
  });

  it("工具后被截断的残词归回上一窗，不出现在后一张思考卡开头", () => {
    const thread: AiThreadItem[] = [
      user("u1", "网络查一下历史上的今天，先search 再 fetch"),
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content: "",
        parts: [
          { type: "reasoning", text: "先 search，再 f" },
          {
            type: "tool-call",
            id: "t-search",
            name: "omni_web_search",
            arguments: "{}",
            status: "completed",
          },
          {
            type: "reasoning",
            text: "etch 抓取相关页面。搜索完成了，我应该 fetch 几个最相关的页面。",
          },
        ],
        timestamp: 1,
      },
      {
        kind: "tool_call",
        id: "t-search",
        toolName: "omni_web_search",
        args: "{}",
        status: "completed",
        timestamp: 1,
      },
    ];
    const text = currentTurnThinkingText(thread);
    expect(text).toContain("搜索完成了");
    expect(text).not.toMatch(/^etch/);
    expect(text).not.toContain("etch 抓取相关页面");
  });

  it("search 仍在 running 时，截断残片粘回工具前思考窗", () => {
    const thread: AiThreadItem[] = [
      user("u1", "网络查一下历史上的今天，先search 再 fetch"),
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content: "",
        parts: [
          { type: "reasoning", text: "先 search，再 f" },
          {
            type: "tool-call",
            id: "t-search",
            name: "omni_web_search",
            arguments: "{}",
            status: "running",
          },
          { type: "reasoning", text: "etch 抓取相关页面。" },
        ],
        timestamp: 1,
      },
    ];
    const text = currentTurnThinkingText(thread);
    expect(text).toContain("fetch 抓取相关页面");
    expect(text).not.toBe("etch 抓取相关页面。");
  });

  it("工具 part 先到、思考在后面刷时，思考仍进当前卡", () => {
    const thread: AiThreadItem[] = [
      user("u1", "网络查一下历史上的今天，先search 再 fetch"),
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool-call",
            id: "t-search",
            name: "omni_web_search",
            arguments: "{}",
            status: "running",
          },
          { type: "reasoning", text: "先用 omni_web_search 搜历史上的今天。" },
        ],
        timestamp: 1,
      },
    ];
    expect(currentTurnThinkingText(thread)).toContain("omni_web_search 搜历史上的今天");
  });

  it("工具前最后一行中文残片不能出现在工具后思考卡开头", () => {
    const pre =
      '用户要求先 search 再 fetch。我先用 omni_web_search 搜索"历史上的今天 8月17日" 搜索';
    const thread: AiThreadItem[] = [
      user("u1", "网络查一下历史上的今天，先search 再 fetch"),
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content: "",
        parts: [
          { type: "reasoning", text: pre },
          {
            type: "tool-call",
            id: "t-search",
            name: "omni_web_search",
            arguments: "{}",
            status: "completed",
          },
          {
            type: "reasoning",
            text:
              '今天 8月17日" 搜索\n搜索结果已经返回了多个关于8月17日历史事件的链接。现在需要 fetch 其中一个链接。',
          },
        ],
        timestamp: 1,
      },
      {
        kind: "tool_call",
        id: "t-search",
        toolName: "omni_web_search",
        args: "{}",
        status: "completed",
        timestamp: 1,
      },
    ];
    const text = currentTurnThinkingText(thread);
    expect(text).toContain("搜索结果已经返回了");
    expect(text).toContain("fetch");
    expect(text).not.toMatch(/^今天 8月17日/);
    expect(text).not.toContain('今天 8月17日" 搜索\n');
  });

  it("同一行切开、无字符重叠时，残片归工具前窗、后窗从新思考起", () => {
    const pre = '用户要求先 search 再 fetch。我先用 omni_web_search 搜索"历史上的';
    const after =
      '今天 8月17日" 搜索结果已经返回了多个关于8月17日历史事件的链接。现在需要按照用户的要求“先search 再 fetch”，fetch其中一个链接。';
    const running: AiThreadItem[] = [
      user("u1", "网络查一下历史上的今天，先search 再 fetch"),
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content: "",
        parts: [
          { type: "reasoning", text: pre },
          {
            type: "tool-call",
            id: "t-search",
            name: "omni_web_search",
            arguments: "{}",
            status: "running",
          },
          { type: "reasoning", text: after },
        ],
        timestamp: 1,
      },
    ];
    const glued = currentTurnThinkingText(running);
    expect(glued).toContain('历史上的今天 8月17日"');
    expect(glued).not.toContain("搜索结果已经返回了");
    expect(toolBoundaryLeftoverFragment(running)).toContain("今天 8月17日");

    const done: AiThreadItem[] = [
      running[0]!,
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content: "",
        parts: [
          { type: "reasoning", text: pre },
          {
            type: "tool-call",
            id: "t-search",
            name: "omni_web_search",
            arguments: "{}",
            status: "completed",
          },
          { type: "reasoning", text: after },
        ],
        timestamp: 1,
      },
      {
        kind: "tool_call",
        id: "t-search",
        toolName: "omni_web_search",
        args: "{}",
        status: "completed",
        timestamp: 1,
      },
    ];
    const next = currentTurnThinkingText(done);
    expect(next).toMatch(/^搜索结果已经返回了/);
    expect(next).not.toMatch(/^今天 8月17日/);
    expect(toolBoundaryLeftoverFragment(done)).toContain("今天 8月17日");
  });

  it("下一工具仍在 running 时，思考窗口停在该工具之前", () => {
    const thread: AiThreadItem[] = [
      user("u1", "网络查一下历史上的今天"),
      {
        kind: "message",
        id: "a1",
        role: "assistant",
        content: "",
        parts: [
          { type: "reasoning", text: "先搜索历史上的今天。" },
          {
            type: "tool-call",
            id: "t-search",
            name: "omni_web_search",
            arguments: "{}",
            status: "completed",
          },
          { type: "reasoning", text: "需要打开百科页面核对。" },
          {
            type: "tool-call",
            id: "t-fetch",
            name: "omni_web_fetch",
            arguments: "{}",
            status: "running",
          },
        ],
        timestamp: 1,
      },
    ];
    const text = currentTurnThinkingText(thread);
    expect(text).toContain("需要打开百科页面核对");
    expect(text).not.toContain("先搜索历史上的今天");
  });
});
