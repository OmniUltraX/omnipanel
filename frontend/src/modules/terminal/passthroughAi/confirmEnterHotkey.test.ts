import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearEnterGateFlags, patchEnterGateFlags } from "./enterGates";

const { state } = vi.hoisted(() => ({
  state: { phase: "awaiting_approval" as string | null },
}));

vi.mock("../../../stores/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({ terminalPassthroughAiEnter: true }),
  },
}));

vi.mock("../shellAgent/shellAgentStore", () => ({
  useShellAgentStore: {
    getState: () => ({
      get: () => (state.phase ? { phase: state.phase } : null),
    }),
  },
}));

import { shouldHandleConfirmEnter } from "./confirmEnterHotkey";

const SID = "pane-1";

function enterEvent(target: EventTarget | null): KeyboardEvent {
  return {
    key: "Enter",
    repeat: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 13,
    target,
  } as unknown as KeyboardEvent;
}

beforeEach(() => {
  state.phase = "awaiting_approval";
  clearEnterGateFlags(SID);
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
  clearEnterGateFlags(SID);
});

describe("shouldHandleConfirmEnter", () => {
  it("焦点在终端外壳而不是 xterm textarea 时仍处理", () => {
    document.body.innerHTML = `<div class="term-pane term-pane-leaf is-active" data-pane-id="${SID}"><div class="terminal-area" tabindex="-1"></div></div>`;
    const area = document.querySelector(".terminal-area") as HTMLElement;
    expect(shouldHandleConfirmEnter(SID, enterEvent(area))).toBe(true);
  });

  it("焦点在侧栏按钮时不抢确认", () => {
    document.body.innerHTML = `<div class="term-pane is-active" data-pane-id="${SID}"></div><button id="side">侧栏</button>`;
    const btn = document.getElementById("side") as HTMLButtonElement;
    expect(shouldHandleConfirmEnter(SID, enterEvent(btn))).toBe(false);
  });

  it("用户正在打字时不抢确认", () => {
    document.body.innerHTML = `<div class="term-pane is-active" data-pane-id="${SID}"></div>`;
    patchEnterGateFlags(SID, { userTyping: true });
    expect(shouldHandleConfirmEnter(SID, enterEvent(document.body))).toBe(false);
  });
});
