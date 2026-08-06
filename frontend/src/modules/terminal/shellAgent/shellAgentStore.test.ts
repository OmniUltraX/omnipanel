import { beforeEach, describe, expect, it } from "vitest";
import { useShellAgentStore } from "./shellAgentStore";

describe("shellAgentStore", () => {
  beforeEach(() => {
    useShellAgentStore.setState({ bySession: {} });
  });

  it("ensure → bumpTurn → setPhase", () => {
    const s = useShellAgentStore.getState().ensure("sess-1");
    expect(s.phase).toBe("idle");
    expect(s.turn).toBe(0);

    useShellAgentStore.getState().setBlockId("sess-1", "blk-1");
    useShellAgentStore.getState().setPhase("sess-1", "streaming");
    useShellAgentStore.getState().bumpTurn("sess-1");

    const next = useShellAgentStore.getState().get("sess-1");
    expect(next?.blockId).toBe("blk-1");
    expect(next?.phase).toBe("streaming");
    expect(next?.turn).toBe(1);
    expect(useShellAgentStore.getState().isBusy("sess-1")).toBe(true);
  });

  it("newAgentThread 重置 turn 与 block", () => {
    useShellAgentStore.getState().ensure("sess-1");
    useShellAgentStore.getState().setBlockId("sess-1", "old");
    useShellAgentStore.getState().bumpTurn("sess-1");
    const prevThread = useShellAgentStore.getState().get("sess-1")!.agentThreadId;

    const created = useShellAgentStore.getState().newAgentThread("sess-1");
    expect(created.blockId).toBeNull();
    expect(created.turn).toBe(0);
    expect(created.agentThreadId).not.toBe(prevThread);
  });

  it("cancel 后不再 busy", () => {
    useShellAgentStore.getState().ensure("sess-1");
    useShellAgentStore.getState().setPhase("sess-1", "executing");
    useShellAgentStore.getState().cancel("sess-1");
    expect(useShellAgentStore.getState().isBusy("sess-1")).toBe(false);
    expect(useShellAgentStore.getState().get("sess-1")?.phase).toBe("cancelled");
  });
});
