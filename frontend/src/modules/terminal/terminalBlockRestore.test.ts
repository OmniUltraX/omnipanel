import { describe, expect, it } from "vitest";
import { normalizeRestoredTerminalBlock, normalizeStaleRunningBlock } from "./terminalBlockRestore";
import type { TerminalBlock } from "../../stores/blocksStore";

function shellBlock(overrides: Partial<TerminalBlock> = {}): TerminalBlock {
  return {
    id: "b1",
    sessionId: "s1",
    command: "cd /tmp",
    output: "",
    exitCode: null,
    startLine: -1,
    endLine: -1,
    marker: null,
    cwd: "/",
    timestamp: 1,
    status: "running",
    ...overrides,
  };
}

describe("normalizeStaleRunningBlock", () => {
  it("将遗留 running shell 块收尾为 completed", () => {
    const next = normalizeStaleRunningBlock(shellBlock());
    expect(next.status).toBe("completed");
    expect(next.exitCode).toBe(0);
    expect(next.completedAt).toBeTypeOf("number");
  });

  it("静默恢复 cd 块收尾为 completed", () => {
    const next = normalizeStaleRunningBlock(
      shellBlock({ silent: true, command: "cd 'C:\\Users\\chaoj'" }),
    );
    expect(next.status).toBe("completed");
    expect(next.silent).toBe(true);
  });

  it("将遗留 running AI 块按内容收尾", () => {
    const withContent = normalizeStaleRunningBlock(
      shellBlock({
        kind: "ai",
        command: "# hello",
        aiThread: [
          {
            kind: "message",
            id: "m1",
            role: "assistant",
            content: "hi",
            timestamp: 1,
          },
        ],
      }),
    );
    expect(withContent.status).toBe("completed");
    expect(withContent.exitCode).toBe(0);

    const empty = normalizeStaleRunningBlock(
      shellBlock({
        kind: "ai",
        command: "# hello",
        aiThread: [],
      }),
    );
    expect(empty.status).toBe("failed");
    expect(empty.exitCode).toBe(1);
  });

  it("已完成 AI 块恢复时清除错误 exitCode", () => {
    const next = normalizeStaleRunningBlock(
      shellBlock({
        kind: "ai",
        status: "completed",
        exitCode: 1,
        command: "# time",
        aiThread: [
          {
            kind: "message",
            id: "m1",
            role: "assistant",
            content: "14:48",
            timestamp: 1,
          },
        ],
      }),
    );
    expect(next.status).toBe("completed");
    expect(next.exitCode).toBe(0);
  });
});

describe("normalizeRestoredTerminalBlock", () => {
  it("从持久化记录恢复时同样收尾 running", () => {
    const restored = normalizeRestoredTerminalBlock({
      id: "b2",
      sessionId: "s1",
      command: "ls",
      output: "a b",
      exitCode: null,
      startLine: -1,
      endLine: -1,
      marker: null,
      cwd: "/",
      timestamp: 2,
      status: "running",
    });
    expect(restored.status).toBe("completed");
  });
});
