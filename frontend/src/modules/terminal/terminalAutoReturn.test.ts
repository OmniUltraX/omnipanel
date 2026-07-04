import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTerminalUiStore } from "./terminalUiStore";
import { useBlocksStore } from "../../stores/blocksStore";
import {
  armAutoReturn,
  clearAutoReturnTracking,
  notifyAltScreenChange,
  trackTerminalOutputForAutoReturn,
  tryAutoReturnAfterBlockEnd,
} from "./terminalAutoReturn";

function setMode(
  sessionId: string,
  mode: "interactive" | "external",
  autoReturn = false,
): void {
  useTerminalUiStore.getState().setInputMode(sessionId, mode, { autoReturn });
}

function resetStores(): void {
  useTerminalUiStore.setState({
    inputModes: {},
    autoReturnToCommandBar: {},
    expandedAiBlockIds: {},
    aiDockHeights: {},
  });
  useBlocksStore.setState({
    blocks: {},
  });
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const SESSION = "auto-return-test";

describe("terminalAutoReturn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    resetStores();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearAutoReturnTracking(SESSION);
    resetStores();
  });

  it("armAutoReturn 标记 armedAt 并保留 autoReturn 标记", () => {
    setMode(SESSION, "interactive", true);

    expect(useTerminalUiStore.getState().shouldAutoReturnToCommandBar(SESSION)).toBe(true);
    expect(useTerminalUiStore.getState().getInputMode(SESSION)).toBe("interactive");
  });

  it("未 arm 时不响应任何输出", () => {
    setMode(SESSION, "interactive", false);

    vi.advanceTimersByTime(700);
    trackTerminalOutputForAutoReturn(SESSION, encode("\x1b[?1049h"));
    trackTerminalOutputForAutoReturn(SESSION, encode("\x1b[?1049l"));

    vi.advanceTimersByTime(500);
    expect(useTerminalUiStore.getState().getInputMode(SESSION)).toBe("interactive");
  });

  it("alt-screen enter→exit 后通过 180ms 调度回到 Command Bar", () => {
    setMode(SESSION, "interactive", true);

    vi.advanceTimersByTime(700);
    trackTerminalOutputForAutoReturn(SESSION, encode("\x1b[?1049h"));
    trackTerminalOutputForAutoReturn(SESSION, encode("\x1b[?1049l"));

    vi.advanceTimersByTime(180);
    expect(useTerminalUiStore.getState().getInputMode(SESSION)).toBe("external");
  });

  it("未先 enter 仅收到 exit 时不触发 auto-return", () => {
    setMode(SESSION, "interactive", true);

    vi.advanceTimersByTime(700);
    trackTerminalOutputForAutoReturn(SESSION, encode("\x1b[?1049l"));

    vi.advanceTimersByTime(500);
    expect(useTerminalUiStore.getState().getInputMode(SESSION)).toBe("interactive");
  });

  it("enter 在一个 chunk、exit 在下一个 chunk 仍能正确触发", () => {
    setMode(SESSION, "interactive", true);

    vi.advanceTimersByTime(700);
    trackTerminalOutputForAutoReturn(SESSION, encode("prefix-\x1b[?1049h-"));
    trackTerminalOutputForAutoReturn(SESSION, encode("postfix-\x1b[?1049l-end"));

    vi.advanceTimersByTime(180);
    expect(useTerminalUiStore.getState().getInputMode(SESSION)).toBe("external");
  });

  it("enter+exit 在同一 chunk 内紧贴 arm 时刻被 grace 抑制", () => {
    setMode(SESSION, "interactive", true);

    trackTerminalOutputForAutoReturn(
      SESSION,
      encode("\x1b[?1049h\x1b[?1049l"),
    );

    vi.advanceTimersByTime(500);
    expect(useTerminalUiStore.getState().getInputMode(SESSION)).toBe("interactive");
  });

  it("1047/47 变体也能识别", () => {
    setMode(SESSION, "interactive", true);

    vi.advanceTimersByTime(700);
    trackTerminalOutputForAutoReturn(SESSION, encode("\x1b[?1047h"));
    trackTerminalOutputForAutoReturn(SESSION, encode("\x1b[?1047l"));

    vi.advanceTimersByTime(180);
    expect(useTerminalUiStore.getState().getInputMode(SESSION)).toBe("external");
  });

  it("notifyAltScreenChange enter→exit 触发 auto-return", () => {
    setMode(SESSION, "interactive", true);

    vi.advanceTimersByTime(700);
    notifyAltScreenChange(SESSION, true);
    notifyAltScreenChange(SESSION, false);

    vi.advanceTimersByTime(180);
    expect(useTerminalUiStore.getState().getInputMode(SESSION)).toBe("external");
  });

  it("notifyAltScreenChange 未 enter 直接 exit 不调度", () => {
    setMode(SESSION, "interactive", true);

    vi.advanceTimersByTime(700);
    notifyAltScreenChange(SESSION, false);

    vi.advanceTimersByTime(500);
    expect(useTerminalUiStore.getState().getInputMode(SESSION)).toBe("interactive");
  });

  it("tryAutoReturnAfterBlockEnd 无 blockId 也能调度（conpty 下的 top/python 路径）", () => {
    setMode(SESSION, "interactive", true);

    vi.advanceTimersByTime(700);
    tryAutoReturnAfterBlockEnd(SESSION);

    vi.advanceTimersByTime(180);
    expect(useTerminalUiStore.getState().getInputMode(SESSION)).toBe("external");
  });

  it("tryAutoReturnAfterBlockEnd 在 alt screen 仍 active 时被抑制", () => {
    setMode(SESSION, "interactive", true);

    vi.advanceTimersByTime(700);
    notifyAltScreenChange(SESSION, true);
    tryAutoReturnAfterBlockEnd(SESSION);

    vi.advanceTimersByTime(500);
    expect(useTerminalUiStore.getState().getInputMode(SESSION)).toBe("interactive");
  });

  it("tryAutoReturnAfterBlockEnd 跳过早于 armedAt 的旧 block", () => {
    setMode(SESSION, "interactive", true);

    const armedAt = Date.now();
    useBlocksStore.getState().addBlock(SESSION, {
      id: "stale-block",
      sessionId: SESSION,
      kind: "shell",
      command: "ls",
      output: "",
      exitCode: 0,
      startLine: 0,
      endLine: 1,
      marker: null,
      cwd: "/tmp",
      timestamp: armedAt - 5_000,
      status: "completed",
    });

    vi.advanceTimersByTime(700);
    tryAutoReturnAfterBlockEnd(SESSION, "stale-block");

    vi.advanceTimersByTime(500);
    expect(useTerminalUiStore.getState().getInputMode(SESSION)).toBe("interactive");
  });

  it("tryAutoReturnAfterBlockEnd 在 600ms grace 内被抑制", () => {
    setMode(SESSION, "interactive", true);

    tryAutoReturnAfterBlockEnd(SESSION);
    vi.advanceTimersByTime(400);
    expect(useTerminalUiStore.getState().getInputMode(SESSION)).toBe("interactive");

    tryAutoReturnAfterBlockEnd(SESSION);
    vi.advanceTimersByTime(400);
    expect(useTerminalUiStore.getState().getInputMode(SESSION)).toBe("interactive");

    tryAutoReturnAfterBlockEnd(SESSION);
    vi.advanceTimersByTime(180);
    expect(useTerminalUiStore.getState().getInputMode(SESSION)).toBe("external");
  });

  it("非 interactive 模式下不调度 auto-return", () => {
    setMode(SESSION, "external", true);

    vi.advanceTimersByTime(700);
    trackTerminalOutputForAutoReturn(SESSION, encode("\x1b[?1049h"));
    trackTerminalOutputForAutoReturn(SESSION, encode("\x1b[?1049l"));

    vi.advanceTimersByTime(500);
    expect(useTerminalUiStore.getState().getInputMode(SESSION)).toBe("external");
  });

  it("clearAutoReturnTracking 重置所有状态并取消 pending timer", () => {
    setMode(SESSION, "interactive", true);

    vi.advanceTimersByTime(700);
    trackTerminalOutputForAutoReturn(SESSION, encode("\x1b[?1049h"));
    trackTerminalOutputForAutoReturn(SESSION, encode("\x1b[?1049l"));
    clearAutoReturnTracking(SESSION);

    vi.advanceTimersByTime(500);
    expect(useTerminalUiStore.getState().getInputMode(SESSION)).toBe("interactive");
  });

  it("切换到 external 模式会取消 pending auto-return", () => {
    setMode(SESSION, "interactive", true);

    vi.advanceTimersByTime(700);
    trackTerminalOutputForAutoReturn(SESSION, encode("\x1b[?1049h"));
    trackTerminalOutputForAutoReturn(SESSION, encode("\x1b[?1049l"));

    useTerminalUiStore.getState().setInputMode(SESSION, "external");

    vi.advanceTimersByTime(500);
    expect(useTerminalUiStore.getState().getInputMode(SESSION)).toBe("external");
  });

  it("重复调用 armAutoReturn 重置 grace 计时", () => {
    setMode(SESSION, "interactive", true);

    vi.advanceTimersByTime(300);
    armAutoReturn(SESSION);

    trackTerminalOutputForAutoReturn(SESSION, encode("\x1b[?1049h"));
    trackTerminalOutputForAutoReturn(SESSION, encode("\x1b[?1049l"));

    vi.advanceTimersByTime(500);
    expect(useTerminalUiStore.getState().getInputMode(SESSION)).toBe("interactive");
  });
});
