import { describe, expect, it, vi } from "vitest";

import {
  hasFullTerminalSignal,
  hasFullTerminalExitSignal,
} from "./fullTerminalSignals";
import {
  buildProfileRejectPayload,
  resolveCommandProfile,
} from "./terminalCommandProfile";
import {
  buildToolResultFromBlock,
  resolveBlockTextOutput,
} from "./resolveToolBlockOutput";
import {
  createEmptyOutputModel,
  flattenOutputModel,
  ingestTerminalOutputChunk,
  isInlineProgressChunk,
  renderLiveOutputText,
} from "./terminalOutputModel";
import {
  useTerminalRunStateStore,
} from "./terminalRunStateStore";
import { resolveTerminalAiContextBundle } from "./terminalAiContextBundle";
import { buildInlineAiHistoryJsonSync, sliceRecentTurns } from "./terminalInlineAiHistory";
import {
  appendInlineAiStreamChunk,
  flushInlineAiStream,
} from "./inlineAiStreamBuffer";
import {
  checkInlineAiStall,
  clearInlineAiWatchdog,
  INLINE_AI_STALL_THRESHOLD_MS,
  touchInlineAiDelta,
} from "./inlineAiWatchdog";
import {
  applyStickyHandoff,
  resolveStickyAiBlockIdWithExpanded,
  STICKY_HANDOFF_INSET_PX,
} from "./useStickyAiBlockId";
import { useBlocksStore, type TerminalBlock } from "../../stores/blocksStore";
import { useTerminalStore } from "../../stores/terminalStore";

/*
 * 手工验收清单（终端 AI 卡片性能与稳定性）
 * | 场景 | 期望 |
 * | 10+ 轮连续追问 | 滚动与渲染流畅，无明显卡顿 |
 * | 思考模型流式输出 | 无突发大段文字，逐帧平滑 |
 * | 工具密集任务 | 不误判卡死，工具回传失败有提示 |
 * | 断网/超时 | 显示 stalled 横幅，可停止/重试 |
 * | 停止后可重试 | cancel 后 block 状态正确，可再次追问 |
 */

/*
 * 手工验收清单（AI 工具命令执行体系）
 * | 场景 | 期望 |
 * | AI date/pwd | block 稳定；tool result 有输出；不重试 |
 * | AI top | 拒绝 + 建议 top -bn1；PTY 无输出 |
 * | AI npm install | Feed 进度；30min 内回传 |
 * | AI tail -f | 拒绝 + 建议 tail -n 100 |
 * | 用户 top/vim | full-terminal |
 * | 用户 docker pull | inline-running 进度 |
 * | 远程 SSH AI date | 远程输出与 cwd 正确 |
 * | 多 tab | session 绑定不串 |
 * | inline + 侧栏 AI | 各路径结果一致 |
 */

describe("terminalCommandProfile", () => {
  it("batch 为默认且 AI 允许执行", () => {
    const profile = resolveCommandProfile("date", "AI");
    expect(profile.kind).toBe("batch");
    expect(profile.allowAiExecution).toBe(true);
    expect(profile.timeoutMs).toBe(15_000);
  });

  it("progress 类命令延长超时", () => {
    const profile = resolveCommandProfile("npm install", "AI");
    expect(profile.kind).toBe("progress");
    expect(profile.timeoutMs).toBe(1_800_000);
    expect(profile.outputIdleMs).toBe(3_000);
  });

  it("snap install 识别为 progress", () => {
    const profile = resolveCommandProfile("snap install lxd", "用户");
    expect(profile.kind).toBe("progress");
  });

  it("拒绝流式命令并附替代建议", () => {
    const profile = resolveCommandProfile("tail -f /var/log/syslog", "AI");
    expect(profile.kind).toBe("streaming");
    expect(profile.allowAiExecution).toBe(false);
    const payload = buildProfileRejectPayload(profile, "tail -f /var/log/syslog");
    expect(payload.status).toBe("rejected_by_policy");
    expect(payload.doNotRetrySameCommand).toBe(true);
    expect(payload.suggestedAlternatives?.length).toBeGreaterThan(0);
  });

  it("拒绝交互式命令 top", () => {
    const profile = resolveCommandProfile("top", "AI");
    expect(profile.kind).toBe("interactive");
    expect(profile.allowAiExecution).toBe(false);
    const payload = buildProfileRejectPayload(profile, "top");
    expect(payload.suggestedAlternatives?.some((s) => s.includes("top -bn1"))).toBe(true);
  });

  it("用户路径不拒绝 top", () => {
    const profile = resolveCommandProfile("top", "用户");
    expect(profile.allowAiExecution).toBe(true);
  });
});

describe("resolveToolBlockOutput", () => {
  const baseBlock = (overrides: Partial<TerminalBlock> = {}): TerminalBlock => ({
    id: "blk-1",
    sessionId: "sess-1",
    kind: "shell",
    command: "echo hi",
    output: "",
    exitCode: 0,
    startLine: -1,
    endLine: -1,
    marker: null,
    cwd: "~",
    timestamp: 1,
    status: "completed",
    ...overrides,
  });

  it("优先合并 liveOutput 与 watch 最长有效输出", () => {
    let model = createEmptyOutputModel();
    model = ingestTerminalOutputChunk(model, "from-live\n");
    const block = baseBlock({ liveOutput: model, output: "short" });
    const merged = resolveBlockTextOutput(block, "echo hi", "from-watch-longer");
    expect(merged).toBe("from-watch-longer");
  });

  it("空输出标记 emptyOutput", () => {
    const payload = buildToolResultFromBlock({
      command: "date",
      block: baseBlock({ output: "" }),
      profile: resolveCommandProfile("date", "AI"),
      cwd: "~",
      startedAt: Date.now(),
    });
    expect(payload.emptyOutput).toBe(true);
    expect(payload.diagnostic).toBeTruthy();
  });

  it("progress 类附带 progressTail", () => {
    const payload = buildToolResultFromBlock({
      command: "npm install",
      block: baseBlock({ output: "line1\nInstalling 99%\n" }),
      profile: resolveCommandProfile("npm install", "AI"),
      cwd: "~",
      startedAt: Date.now() - 100,
    });
    expect(payload.progressTail).toBe("Installing 99%");
    expect(payload.profileKind).toBe("progress");
  });
});

describe("terminalOutputModel", () => {
  it("覆盖当前行并保留已完成行", () => {
    let model = createEmptyOutputModel();
    model = ingestTerminalOutputChunk(model, "line1\n");
    model = ingestTerminalOutputChunk(model, "progress 10%\rprogress 50%\rprogress 100%\n");
    expect(flattenOutputModel(model)).toBe("line1\nprogress 100%");
  });

  it("识别进度类输出片段", () => {
    expect(isInlineProgressChunk("Downloading\rDownloading 50%")).toBe(true);
    expect(
      isInlineProgressChunk(
        '5.21/stable  47% 3.89MB/s 16.6s Download snap "lxd"\n',
      ),
    ).toBe(true);
    expect(isInlineProgressChunk("plain line\n")).toBe(false);
  });

  it("合并换行刷新的进度行", () => {
    let model = createEmptyOutputModel();
    model = ingestTerminalOutputChunk(
      model,
      '5.21/stable  47% 3.89MB/s 16.6s Download snap "lxd"\n',
    );
    model = ingestTerminalOutputChunk(
      model,
      '5.21/stable  50% 4.01MB/s 15.2s Download snap "lxd"\n',
    );
    model = ingestTerminalOutputChunk(
      model,
      '5.21/stable  55% 4.12MB/s 14.0s Download snap "lxd"\n',
    );
    expect(flattenOutputModel(model)).toBe(
      '5.21/stable  55% 4.12MB/s 14.0s Download snap "lxd"',
    );
  });
});

describe("terminalRunStateStore", () => {
  it("遵循 prompt → block-running → inline-running → prompt 迁移", () => {
    const store = useTerminalRunStateStore.getState();
    const sessionId = "test-session-run-state";

    store.clearSession(sessionId);
    expect(store.getRunState(sessionId)).toBe("prompt");

    store.beginBlockRun(sessionId, { blockId: "blk-1", command: "docker pull" });
    expect(store.getRunState(sessionId)).toBe("block-running");
    expect(store.shouldAppendBlockOutput(sessionId)).toBe(true);

    store.promoteToInlineRun(sessionId);
    expect(store.getRunState(sessionId)).toBe("inline-running");

    store.enterFullTerminal(sessionId, "blk-1");
    expect(store.isFullTerminal(sessionId)).toBe(true);
    expect(store.shouldAppendBlockOutput(sessionId)).toBe(false);

    store.returnToPrompt(sessionId);
    expect(store.getRunState(sessionId)).toBe("prompt");
  });

  it("ai-tool-running 不触发 live xterm，inline 升级后仍静默", () => {
    const store = useTerminalRunStateStore.getState();
    const sessionId = "test-ai-tool-run";

    store.clearSession(sessionId);
    store.beginAiToolRun(sessionId, { blockId: "blk-ai", command: "npm install" });
    expect(store.isAiToolRunning(sessionId)).toBe(true);
    expect(store.shouldShowLiveXterm(sessionId)).toBe(false);
    expect(store.shouldCaptureBlockOutput(sessionId, true)).toBe(true);

    store.promoteToInlineRun(sessionId);
    expect(store.getRunState(sessionId)).toBe("inline-running");
    expect(store.isAiToolRunning(sessionId)).toBe(true);
    expect(store.shouldShowLiveXterm(sessionId)).toBe(false);
  });
});

describe("fullTerminalSignals", () => {
  it("仅对强 TUI 信号返回 true", () => {
    const alt = new TextEncoder().encode("\x1b[?1049h");
    const clear = new TextEncoder().encode("\x1b[2J");
    expect(hasFullTerminalSignal(alt)).toBe(true);
    expect(hasFullTerminalSignal(clear)).toBe(false);
  });

  it("alt screen 退出信号可被检测", () => {
    const exit = new TextEncoder().encode("\x1b[?1049l");
    const enter = new TextEncoder().encode("\x1b[?1049h");
    const mouseExit = new TextEncoder().encode("\x1b[?1000l");
    expect(hasFullTerminalExitSignal(exit)).toBe(true);
    // 进入信号不应被误判为退出
    expect(hasFullTerminalExitSignal(enter)).toBe(false);
    // 鼠标关闭不作为退出信号（误报率高）
    expect(hasFullTerminalExitSignal(mouseExit)).toBe(false);
  });
});

describe("terminalAiContextBundle", () => {
  it("远程终端不把 cwd 传给本地 Agent", () => {
    const sessionId = "remote-tab-ctx";
    useTerminalStore.setState({
      tabs: [
        {
          id: sessionId,
          sessionId,
          title: "p1",
          session: {
            type: "remote",
            resourceId: "ssh-1",
            cwd: "/root",
            shellLabel: "bash",
          },
        },
      ],
      activeTabId: sessionId,
    } as never);

    const bundle = resolveTerminalAiContextBundle(sessionId, "terminal-inline");
    expect(bundle?.localAgentCwd).toBeNull();
    expect(bundle?.remoteWorkingDirectory).toBe("/root");
    expect(bundle?.terminalContextAppend).toContain("/root");
    expect(bundle?.terminalContextAppend).toContain("[Local Agent Runtime]");
  });
});

describe("terminalInlineAiHistory", () => {
  it("从 aiThread 构建独立历史", () => {
    const blockId = "blk-inline-history";
    useBlocksStore.setState({
      blocks: {
        "sess-1": [
          {
            id: blockId,
            sessionId: "sess-1",
            kind: "ai",
            command: "# hi",
            output: "",
            exitCode: null,
            startLine: -1,
            endLine: -1,
            marker: null,
            cwd: "~",
            timestamp: Date.now(),
            status: "running",
            aiThread: [
              {
                kind: "message",
                id: "m1",
                role: "user",
                content: "pwd",
                timestamp: 1,
              },
              {
                kind: "message",
                id: "m2",
                role: "assistant",
                content: "/root",
                timestamp: 2,
              },
            ],
          },
        ],
      },
    });

    const json = buildInlineAiHistoryJsonSync(blockId);
    expect(json).toBeTruthy();
    const parsed = JSON.parse(json!) as Array<{ role: string; content: string }>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0].content).toBe("pwd");
  });

  it("超过阈值时保留最近 N 轮原文", () => {
    const blockId = "blk-inline-history-long";
    const messages = Array.from({ length: 14 }, (_, index) => ({
      kind: "message" as const,
      id: `m-${index}`,
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `msg-${index}`,
      timestamp: index,
    }));

    useBlocksStore.setState({
      blocks: {
        "sess-1": [
          {
            id: blockId,
            sessionId: "sess-1",
            kind: "ai",
            command: "# hi",
            output: "",
            exitCode: null,
            startLine: -1,
            endLine: -1,
            marker: null,
            cwd: "~",
            timestamp: Date.now(),
            status: "running",
            aiThread: messages,
          },
        ],
      },
    });

    const recent = sliceRecentTurns(messages, 6);
    expect(recent.length).toBeGreaterThan(0);
    expect(recent[0].id).toBe(`m-${messages.length - 12}`);

    const json = buildInlineAiHistoryJsonSync(blockId);
    const parsed = JSON.parse(json!) as Array<{ role: string; content: string }>;
    expect(parsed.length).toBeLessThanOrEqual(24);
    expect(parsed.some((item) => item.content === `msg-${messages.length - 1}`)).toBe(true);
  });
});

describe("inlineAiStreamBuffer", () => {
  it("批量 flush 合并 chunk 到 store", () => {
    const blockId = "blk-stream-buffer";
    const messageId = "assistant-1";
    useBlocksStore.setState({
      blocks: {
        "sess-1": [
          {
            id: blockId,
            sessionId: "sess-1",
            kind: "ai",
            command: "# hi",
            output: "",
            exitCode: null,
            startLine: -1,
            endLine: -1,
            marker: null,
            cwd: "~",
            timestamp: Date.now(),
            status: "running",
            aiThread: [
              {
                kind: "message",
                id: messageId,
                role: "assistant",
                content: "",
                timestamp: 1,
              },
            ],
          },
        ],
      },
    });

    appendInlineAiStreamChunk(blockId, messageId, "content", "hello ");
    appendInlineAiStreamChunk(blockId, messageId, "content", "world");
    flushInlineAiStream(blockId, messageId);

    const block = useBlocksStore.getState().findBlockById(blockId);
    const assistant = block?.aiThread?.find((item) => item.id === messageId);
    expect(assistant && "content" in assistant ? assistant.content : "").toBe("hello world");
  });
});

describe("inlineAiWatchdog", () => {
  it("无 delta 超阈值后标记 stalled", () => {
    const blockId = "blk-watchdog";
    clearInlineAiWatchdog(blockId);

    const base = Date.now();
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(base);
    touchInlineAiDelta(blockId);
    expect(checkInlineAiStall(blockId)).toBe(false);

    nowSpy.mockReturnValue(base + INLINE_AI_STALL_THRESHOLD_MS + 1_000);
    expect(checkInlineAiStall(blockId)).toBe(true);
    expect(checkInlineAiStall(blockId)).toBe(true);

    clearInlineAiWatchdog(blockId);
    nowSpy.mockRestore();
  });
});

describe("useStickyAiBlockId handoff", () => {
  const blocks = [
    { id: "ai-1", kind: "ai" },
    { id: "shell-1", kind: "shell" },
    { id: "ai-2", kind: "ai" },
  ] as TerminalBlock[];

  const container = {
    getBoundingClientRect: () => ({
      top: 100,
      bottom: 500,
      left: 0,
      right: 400,
      width: 400,
      height: 400,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    }),
  } as HTMLElement;

  it("向下切换较新 AI 时需超过 handoff 线", () => {
    const handoffLine = 500 - STICKY_HANDOFF_INSET_PX;
    const entries = [
      { blockId: "ai-1", rect: { top: -200, bottom: 200 } as DOMRect },
      { blockId: "ai-2", rect: { top: handoffLine + 20, bottom: 520 } as DOMRect },
    ];

    expect(applyStickyHandoff("ai-1", "ai-2", blocks, entries, container)).toBe("ai-1");

    entries[1].rect = { top: handoffLine - 10, bottom: 520 } as DOMRect;
    expect(applyStickyHandoff("ai-1", "ai-2", blocks, entries, container)).toBe("ai-2");
  });

  it("向上滚回较早 AI 时立即切换", () => {
    const entries = [
      { blockId: "ai-1", rect: { top: 120, bottom: 300 } as DOMRect },
      { blockId: "ai-2", rect: { top: 400, bottom: 600 } as DOMRect },
    ];

    expect(applyStickyHandoff("ai-2", "ai-1", blocks, entries, container)).toBe("ai-1");
  });

  it("有展开 AI 时锁定吸顶，忽略滚动解析", () => {
    const list = document.createElement("div");
    const segment1 = document.createElement("div");
    segment1.dataset.blockId = "ai-1";
    list.appendChild(segment1);
    const segment2 = document.createElement("div");
    segment2.dataset.blockId = "ai-2";
    list.appendChild(segment2);

    const feed = document.createElement("div");
    feed.appendChild(list);

    expect(
      resolveStickyAiBlockIdWithExpanded(feed, list, blocks, "ai-1"),
    ).toBe("ai-1");
  });
});

describe("terminalRunStateStore block output gating", () => {
  it("full-terminal 时停止 block 输出，prompt+feed capture 仍应允许采集", () => {
    const store = useTerminalRunStateStore.getState();
    const sessionId = "test-output-gate";
    store.clearSession(sessionId);

    expect(store.isFullTerminal(sessionId)).toBe(false);
    expect(store.shouldAppendBlockOutput(sessionId)).toBe(false);
    expect(store.shouldCaptureBlockOutput(sessionId, true)).toBe(true);

    store.beginBlockRun(sessionId, { blockId: "blk-ai" });
    expect(store.shouldAppendBlockOutput(sessionId)).toBe(true);
    expect(store.shouldCaptureBlockOutput(sessionId, true)).toBe(true);

    store.enterFullTerminal(sessionId, "blk-ai");
    expect(store.isFullTerminal(sessionId)).toBe(true);
    expect(store.shouldAppendBlockOutput(sessionId)).toBe(false);
    expect(store.shouldCaptureBlockOutput(sessionId, true)).toBe(false);
    expect(store.shouldCaptureBlockOutput(sessionId, false)).toBe(false);
  });
});

describe("terminal history flatten", () => {
  it("持久化前应压平 liveOutput 到 output 文本", () => {
    let model = createEmptyOutputModel();
    model = ingestTerminalOutputChunk(model, "persisted-line\n");
    const flattened = renderLiveOutputText(model, "");
    expect(flattened).toContain("persisted-line");
    expect(flattenOutputModel(model)).toBe(flattened);
  });
});
