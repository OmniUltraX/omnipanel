import { describe, expect, it } from "vitest";
import type { TerminalBlock } from "./blocksStore";
import {
  recordTerminalSessionActivity,
  resolveSessionActivityAt,
  shouldRecordTerminalSessionActivity,
} from "./terminalSessionActivity";
import type { TerminalSession } from "./terminalSessionModel";
import {
  beginSilentHistorySync,
  finishSilentHistorySync,
  SHELL_HISTORY_SYNC_COMMAND,
} from "../modules/terminal/commandBar/shellHistorySync";
import { useTerminalStore } from "./terminalStore";

function session(id: string, lastActiveAt = 0): TerminalSession {
  return {
    id,
    title: id,
    session: {
      type: "local",
      resourceId: "local-terminal",
      shellLabel: "Shell",
      cwd: "~/",
      purpose: "Local",
      commandPack: [],
    },
    createdAt: 1_000,
    lastActiveAt,
    lifecycle: "active",
  };
}

describe("resolveSessionActivityAt", () => {
  it("prefers latest shell block timestamp over session fallback", () => {
    const blocks: Record<string, TerminalBlock[]> = {
      "s-1": [
        {
          id: "b-1",
          sessionId: "s-1",
          kind: "shell",
          command: "ls",
          output: "a\n",
          exitCode: 0,
          startLine: 0,
          endLine: 1,
          marker: null,
          cwd: "~/",
          timestamp: 5_000,
          completedAt: 6_000,
          status: "completed",
        },
      ],
    };
    expect(resolveSessionActivityAt(session("s-1", 2_000), blocks)).toBe(6_000);
  });

  it("ignores ai blocks and falls back to createdAt when no activity", () => {
    const blocks: Record<string, TerminalBlock[]> = {
      "s-2": [
        {
          id: "b-ai",
          sessionId: "s-2",
          kind: "ai",
          command: "",
          output: "",
          exitCode: null,
          startLine: 0,
          endLine: 0,
          marker: null,
          cwd: "~/",
          timestamp: 9_000,
          status: "running",
        },
      ],
    };
    expect(resolveSessionActivityAt(session("s-2", 0), blocks)).toBe(1_000);
  });

  it("ignores internal shell sync blocks when resolving activity", () => {
    const blocks: Record<string, TerminalBlock[]> = {
      "s-3": [
        {
          id: "b-sync",
          sessionId: "s-3",
          kind: "shell",
          command: SHELL_HISTORY_SYNC_COMMAND,
          output: "",
          exitCode: 0,
          startLine: 0,
          endLine: 1,
          marker: null,
          cwd: "~/",
          timestamp: 99_000,
          completedAt: 99_500,
          status: "completed",
        },
      ],
    };
    expect(resolveSessionActivityAt(session("s-3", 2_000), blocks)).toBe(2_000);
  });
});

describe("recordTerminalSessionActivity", () => {
  it("skips silent history sync traffic", () => {
    const tabId = useTerminalStore.getState().addLocalTerminalTab("同步测试");
    const sessionId =
      useTerminalStore.getState().tabs.find((tab) => tab.id === tabId)?.sessionId ?? "";
    const before =
      useTerminalStore.getState().sessions.find((s) => s.id === sessionId)?.lastActiveAt ?? 0;

    beginSilentHistorySync(sessionId);
    recordTerminalSessionActivity(sessionId, Date.now(), {
      command: SHELL_HISTORY_SYNC_COMMAND,
    });
    finishSilentHistorySync(sessionId);

    const after =
      useTerminalStore.getState().sessions.find((s) => s.id === sessionId)?.lastActiveAt ?? 0;
    expect(after).toBe(before);
    expect(
      shouldRecordTerminalSessionActivity(sessionId, {
        command: SHELL_HISTORY_SYNC_COMMAND,
      }),
    ).toBe(false);

    useTerminalStore.setState({
      sessions: [],
      tabs: [],
      activeTabId: null,
      activeSessionId: null,
      detachedRuntime: {},
      embeddedPanes: {},
    });
  });

  it("records genuine user commands", () => {
    expect(
      shouldRecordTerminalSessionActivity("s-user", { command: "ls -la" }),
    ).toBe(true);
  });
});
