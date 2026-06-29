import { describe, expect, it, beforeEach } from "vitest";
import {
  buildSessionResumeCdCommand,
  isRestorableSessionCwd,
  isReturningTerminalSession,
} from "./terminalSessionResume";
import { useBlocksStore } from "../../stores/blocksStore";
import { useTerminalStore } from "../../stores/terminalStore";

describe("terminalSessionResume", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      sessions: [],
      tabs: [],
      activeTabId: null,
      activeSessionId: null,
      detachedRuntime: {},
      embeddedPanes: {},
    });
    useBlocksStore.setState({ blocks: {} });
  });
  it("识别可恢复的工作目录", () => {
    expect(isRestorableSessionCwd("C:\\Users\\chaoj\\WorkBuddy")).toBe(true);
    expect(isRestorableSessionCwd("/home/user/proj")).toBe(true);
    expect(isRestorableSessionCwd("~")).toBe(false);
    expect(isRestorableSessionCwd("~/workspace")).toBe(false);
  });

  it("从会话元数据生成恢复 cd 命令", () => {
    const sessionId = useTerminalStore.getState().createSession("test", {
      type: "local",
      resourceId: "local-terminal",
      shellLabel: "PowerShell",
      cwd: "C:\\Users\\chaoj\\WorkBuddy",
      purpose: "Local",
      commandPack: [],
    });
    expect(buildSessionResumeCdCommand(sessionId)).toBe(
      "cd 'C:\\Users\\chaoj\\WorkBuddy'",
    );
  });

  it("有历史 block 视为回归会话", () => {
    const sessionId = useTerminalStore.getState().createSession("test", {
      type: "local",
      resourceId: "local-terminal",
      shellLabel: "PowerShell",
      cwd: "~",
      purpose: "Local",
      commandPack: [],
    });
    expect(isReturningTerminalSession(sessionId)).toBe(false);
    useBlocksStore.getState().addBlock(sessionId, {
      id: "b1",
      sessionId,
      kind: "shell",
      command: "ls",
      output: "ok",
      exitCode: 0,
      startLine: 0,
      endLine: 0,
      marker: null,
      cwd: "/tmp",
      timestamp: Date.now(),
      status: "completed",
    });
    expect(isReturningTerminalSession(sessionId)).toBe(true);
  });
});
