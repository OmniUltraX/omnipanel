import { describe, expect, it } from "vitest";

import { hasFullTerminalSignal } from "./fullTerminalSignals";
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
import { buildInlineAiHistoryJson } from "./terminalInlineAiHistory";
import { useBlocksStore, type TerminalBlock } from "../../stores/blocksStore";
import { useTerminalStore } from "../../stores/terminalStore";

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
    expect(isInlineProgressChunk("plain line\n")).toBe(false);
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

    const json = buildInlineAiHistoryJson(blockId);
    expect(json).toBeTruthy();
    const parsed = JSON.parse(json!) as Array<{ role: string; content: string }>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0].content).toBe("pwd");
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
