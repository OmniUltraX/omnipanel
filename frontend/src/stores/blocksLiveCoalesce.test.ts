import { describe, expect, it, beforeEach, vi } from "vitest";

// blocksStore 的传递依赖会拉起 hooks/useTerminal（模块顶层跑 setupListener，
// jsdom 下无 tauri 后端，属于既有环境噪音）：此处与终端逻辑无关，直接 mock 掉。
vi.mock("../hooks/useTerminal", () => ({}));

import {
  flushBlockLiveOutputForTests,
  useBlocksStore,
  type TerminalBlock,
} from "./blocksStore";

function seedBlock(): void {
  useBlocksStore.setState({ blocks: {} });
  const block: TerminalBlock = {
    id: "b1",
    sessionId: "s1",
    command: "echo hi",
    output: "",
    exitCode: null,
    startLine: 0,
    endLine: 0,
    marker: null,
    cwd: "/",
    timestamp: Date.now(),
    status: "running",
  };
  useBlocksStore.getState().addBlock("s1", block);
}

describe("blocksStore 实时输出合并", () => {
  beforeEach(() => {
    flushBlockLiveOutputForTests();
    useBlocksStore.setState({ blocks: {} });
  });

  it("高频 append 合并为一次 set，flush 后内容齐全", () => {
    seedBlock();
    let notifications = 0;
    const unsub = useBlocksStore.subscribe(() => {
      notifications += 1;
    });
    const { appendBlockLiveOutput } = useBlocksStore.getState();
    appendBlockLiveOutput("b1", "hello ");
    appendBlockLiveOutput("b1", "world");
    appendBlockLiveOutput("b1", "!");
    // 合并窗口内不落 set
    expect(notifications).toBe(0);
    flushBlockLiveOutputForTests();
    expect(notifications).toBe(1);
    const block = useBlocksStore.getState().blocks["s1"][0];
    expect(JSON.stringify(block.liveOutput)).toContain("hello");
    expect(JSON.stringify(block.liveOutput)).toContain("world");
    unsub();
  });
});
