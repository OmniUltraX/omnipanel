import { beforeEach, describe, expect, it } from "vitest";
import {
  createBlockId,
  syncBlockCounterFromIds,
  useBlocksStore,
  type TerminalBlock,
} from "./blocksStore";

function shellBlock(id: string, sessionId = "s-1"): TerminalBlock {
  return {
    id,
    sessionId,
    kind: "shell",
    command: "echo hi",
    output: "",
    exitCode: null,
    startLine: 0,
    endLine: -1,
    marker: null,
    cwd: "~",
    timestamp: 1,
    status: "running",
  };
}

describe("blocksStore block ids", () => {
  beforeEach(() => {
    useBlocksStore.setState({ blocks: {} });
    syncBlockCounterFromIds([]);
  });

  it("syncBlockCounterFromIds advances createBlockId past restored ids", () => {
    syncBlockCounterFromIds([{ id: "blk-10" }, { id: "blk-3" }]);
    expect(createBlockId()).toBe("blk-11");
  });

  it("addBlock replaces an existing block with the same id", () => {
    const store = useBlocksStore.getState();
    store.addBlock("s-1", shellBlock("blk-10"));
    store.addBlock("s-1", { ...shellBlock("blk-10"), command: "ls" });

    const blocks = useBlocksStore.getState().getBlocks("s-1");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.command).toBe("ls");
  });

  it("replaceSessionBlocks dedupes duplicate ids", () => {
    useBlocksStore.getState().replaceSessionBlocks("s-1", [
      shellBlock("blk-10"),
      { ...shellBlock("blk-10"), command: "latest" },
    ]);

    const blocks = useBlocksStore.getState().getBlocks("s-1");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.command).toBe("latest");
  });
});
