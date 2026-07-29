import { describe, expect, it } from "vitest";
import {
  resolveStickyPlanId,
  resolveStickyUserMessageId,
} from "./useStickyPlanId";

function mockRect(top: number, bottom = top + 40): DOMRect {
  return {
    top,
    bottom,
    left: 0,
    right: 100,
    width: 100,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function planEl(id: string, top: number): HTMLElement {
  const el = document.createElement("div");
  el.dataset.planId = id;
  el.getBoundingClientRect = () => mockRect(top);
  return el;
}

function userEl(id: string, top: number): HTMLElement {
  const el = document.createElement("div");
  el.dataset.messageId = id;
  el.getBoundingClientRect = () => mockRect(top);
  return el;
}

describe("resolveStickyPlanId", () => {
  it("无可视区域上方的 Plan 时不吸顶", () => {
    const viewport = document.createElement("div");
    viewport.getBoundingClientRect = () => mockRect(100, 500);

    const id = resolveStickyPlanId(viewport, [
      planEl("p1", 120),
      planEl("p2", 300),
    ]);
    expect(id).toBeNull();
  });

  it("取视口上方最后一个 Plan", () => {
    const viewport = document.createElement("div");
    viewport.getBoundingClientRect = () => mockRect(100, 500);

    const id = resolveStickyPlanId(viewport, [
      planEl("p1", 20),
      planEl("p2", 60),
      planEl("p3", 200),
    ]);
    expect(id).toBe("p2");
  });

  it("全部滚过时吸顶最后一个", () => {
    const viewport = document.createElement("div");
    viewport.getBoundingClientRect = () => mockRect(100, 500);

    const id = resolveStickyPlanId(viewport, [
      planEl("p1", -40),
      planEl("p2", 10),
    ]);
    expect(id).toBe("p2");
  });
});

describe("resolveStickyUserMessageId", () => {
  it("取视口上方最后一条用户消息", () => {
    const viewport = document.createElement("div");
    viewport.getBoundingClientRect = () => mockRect(100, 500);

    const id = resolveStickyUserMessageId(viewport, [
      userEl("u1", 10),
      userEl("u2", 50),
      userEl("u3", 180),
    ]);
    expect(id).toBe("u2");
  });
});
