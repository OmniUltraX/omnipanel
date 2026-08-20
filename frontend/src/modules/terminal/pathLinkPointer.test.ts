import { describe, expect, it } from "vitest";
import {
  bufferCellFromPointer,
  shouldHandlePathLinkPointer,
} from "./pathLinkPointer";
import type { Terminal } from "@xterm/xterm";

function mockTerm(opts?: { viewportY?: number }): Terminal {
  const screen = {
    getBoundingClientRect: () => ({
      left: 10,
      top: 20,
      right: 810,
      bottom: 420,
      width: 800,
      height: 400,
    }),
  };
  return {
    cols: 80,
    rows: 20,
    element: {
      contains: (node: Node) => node === (screen as unknown as Node) || node === document.body,
      querySelector: (sel: string) => (sel === ".xterm-screen" ? screen : null),
    },
    buffer: { active: { viewportY: opts?.viewportY ?? 0 } },
  } as unknown as Terminal;
}

describe("bufferCellFromPointer", () => {
  it("screen 外返回 null", () => {
    expect(bufferCellFromPointer(mockTerm(), 0, 0)).toBeNull();
  });

  it("按格子尺寸换算 1-based 行列", () => {
    const pos = bufferCellFromPointer(mockTerm(), 10 + 10 * 10 + 1, 20 + 20 * 2 + 1);
    expect(pos).toEqual({ col: 11, line: 3 });
  });

  it("viewport 滚动后行号加上 viewportY", () => {
    const pos = bufferCellFromPointer(mockTerm({ viewportY: 5 }), 11, 21);
    expect(pos).toEqual({ col: 1, line: 6 });
  });
});

describe("shouldHandlePathLinkPointer", () => {
  it("点在预览 overlay 上忽略", () => {
    const overlay = document.createElement("div");
    overlay.className = "subwindow-overlay";
    const btn = document.createElement("button");
    overlay.appendChild(btn);
    document.body.appendChild(overlay);
    const term = mockTerm();
    expect(shouldHandlePathLinkPointer(term, { button: 0, target: btn })).toBe(false);
    overlay.remove();
  });
});
