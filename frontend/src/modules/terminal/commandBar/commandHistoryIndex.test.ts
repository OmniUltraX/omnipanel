import { describe, expect, it } from "vitest";
import { buildHistoryIndex } from "./commandHistoryIndex";
import type { TerminalBlock } from "../../../stores/blocksStore";

describe("buildHistoryIndex", () => {
  it("会话块（含 AI）排在 readline 之前", () => {
    const blocks: TerminalBlock[] = [
      {
        id: "ai-1",
        sessionId: "s1",
        kind: "ai",
        command: "# 部署到生产",
        output: "",
        exitCode: 0,
        startLine: 0,
        endLine: 0,
        marker: null,
        cwd: "/",
        timestamp: 2_000,
        status: "completed",
        aiThread: [
          {
            kind: "message",
            id: "m1",
            role: "user",
            content: "部署到生产",
            timestamp: 2_000,
          },
        ],
      },
    ];
    const readline = ["cargo build", "cargo run", "ls"];
    const index = buildHistoryIndex(blocks, readline);
    const aiIndex = index.findIndex((entry) => entry.kind === "ai");
    const readlineIndex = index.findIndex((entry) => entry.kind === "readline");
    expect(aiIndex).toBeGreaterThanOrEqual(0);
    expect(readlineIndex).toBeGreaterThan(aiIndex);
  });
});
