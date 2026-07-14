import { describe, expect, it } from "vitest";
import type { TerminalBlock } from "../../stores/blocksStore";
import {
  feedBlockMatchesSearch,
  isFeedSearchFiltering,
  listFeedSearchMatchIds,
} from "./feedSearchModel";

function shellBlock(overrides: Partial<TerminalBlock> = {}): TerminalBlock {
  return {
    id: "b1",
    kind: "shell",
    command: "ls",
    output: "file.txt\n",
    status: "completed",
    timestamp: Date.now(),
    cwd: "/tmp",
    exitCode: 0,
    silent: false,
    liveOutput: "",
    ...overrides,
  } as TerminalBlock;
}

describe("feedSearchModel", () => {
  it("detects active filtering", () => {
    expect(isFeedSearchFiltering({ query: "", kind: "all", failedOnly: false })).toBe(false);
    expect(isFeedSearchFiltering({ query: "ls", kind: "all", failedOnly: false })).toBe(true);
    expect(isFeedSearchFiltering({ query: "", kind: "shell", failedOnly: false })).toBe(true);
  });

  it("matches command and output text", () => {
    const block = shellBlock();
    expect(feedBlockMatchesSearch(block, { query: "file.txt", kind: "all", failedOnly: false })).toBe(true);
    expect(feedBlockMatchesSearch(block, { query: "missing", kind: "all", failedOnly: false })).toBe(false);
  });

  it("filters failed blocks only", () => {
    const ok = shellBlock({ id: "ok" });
    const bad = shellBlock({ id: "bad", exitCode: 1, status: "failed" });
    const ids = listFeedSearchMatchIds([ok, bad], { query: "", kind: "all", failedOnly: true }, () => true);
    expect(ids).toEqual(["bad"]);
  });
});

describe("feedSearchHighlight", () => {
  it("marks case-insensitive substring indices", async () => {
    const { substringHighlightIndices } = await import("./feedSearchHighlight");
    const indices = substringHighlightIndices("Hello FILE.txt", "file");
    expect(indices.has(6)).toBe(true);
    expect(indices.has(9)).toBe(true);
    expect(indices.has(0)).toBe(false);
  });
});
