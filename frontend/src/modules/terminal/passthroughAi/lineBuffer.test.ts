import { describe, expect, it } from "vitest";
import {
  applyUserDataToLineBuffer,
  createLineBuffer,
  resetLineBuffer,
} from "./lineBuffer";
import {
  canInterceptEnterForAi,
  createEnterGateFlags,
  detectReverseSearchInOutput,
} from "./enterGates";

describe("passthroughAi/lineBuffer", () => {
  it("累积可打印字符", () => {
    let state = createLineBuffer();
    state = applyUserDataToLineBuffer(state, "当");
    state = applyUserDataToLineBuffer(state, "前");
    expect(state.text).toBe("当前");
    expect(state.reliable).toBe(true);
  });

  it("退格与 Ctrl+U", () => {
    let state = applyUserDataToLineBuffer(createLineBuffer(), "abc");
    state = applyUserDataToLineBuffer(state, "\x7f");
    expect(state.text).toBe("ab");
    state = applyUserDataToLineBuffer(state, "\x15");
    expect(state.text).toBe("");
  });

  it("回车复位", () => {
    let state = applyUserDataToLineBuffer(createLineBuffer(), "ls");
    state = applyUserDataToLineBuffer(state, "\r");
    expect(state.text).toBe("");
  });

  it("控制字符标不可信", () => {
    let state = applyUserDataToLineBuffer(createLineBuffer(), "hi");
    state = applyUserDataToLineBuffer(state, "\t");
    expect(state.text).toBe("hi");
    expect(state.reliable).toBe(false);
    state = resetLineBuffer(state);
    expect(state.reliable).toBe(true);
  });
});

describe("passthroughAi/enterGates", () => {
  it("门闩关闭时不可拦截", () => {
    expect(canInterceptEnterForAi(createEnterGateFlags())).toBe(true);
    expect(
      canInterceptEnterForAi({ ...createEnterGateFlags(), altScreen: true }),
    ).toBe(false);
    expect(
      canInterceptEnterForAi({ ...createEnterGateFlags(), reverseSearch: true }),
    ).toBe(false);
    expect(
      canInterceptEnterForAi({ ...createEnterGateFlags(), commandRunning: true }),
    ).toBe(false);
    expect(
      canInterceptEnterForAi({ ...createEnterGateFlags(), agentExecuting: true }),
    ).toBe(false);
  });

  it("识别 reverse-i-search", () => {
    expect(detectReverseSearchInOutput("(reverse-i-search)`foo': bar")).toBe(true);
    expect(detectReverseSearchInOutput("normal output")).toBe(false);
  });
});
