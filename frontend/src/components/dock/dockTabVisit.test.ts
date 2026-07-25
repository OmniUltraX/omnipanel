import { describe, expect, it } from "vitest";
import {
  createInitialDockTabVisited,
  markDockTabVisited,
  shouldMountDockTabContent,
} from "./dockTabVisit";

describe("shouldMountDockTabContent", () => {
  it("挂起且不保活：一律不挂", () => {
    expect(
      shouldMountDockTabContent({
        active: true,
        visited: true,
        contentSuspended: true,
      }),
    ).toBe(false);
  });

  it("挂起且保活：已访问仍挂", () => {
    expect(
      shouldMountDockTabContent({
        active: false,
        visited: true,
        contentSuspended: true,
        keepVisitedWhileSuspended: true,
      }),
    ).toBe(true);
  });

  it("挂起且保活：未访问仍不挂", () => {
    expect(
      shouldMountDockTabContent({
        active: false,
        visited: false,
        contentSuspended: true,
        keepVisitedWhileSuspended: true,
      }),
    ).toBe(false);
  });

  it("激活 Tab 可挂", () => {
    expect(
      shouldMountDockTabContent({
        active: true,
        visited: false,
        contentSuspended: false,
      }),
    ).toBe(true);
  });

  it("已访问非激活可挂（sticky）", () => {
    expect(
      shouldMountDockTabContent({
        active: false,
        visited: true,
        contentSuspended: false,
      }),
    ).toBe(true);
  });

  it("未访问非激活不挂", () => {
    expect(
      shouldMountDockTabContent({
        active: false,
        visited: false,
        contentSuspended: false,
      }),
    ).toBe(false);
  });
});

describe("markDockTabVisited / createInitialDockTabVisited", () => {
  it("初始含激活 id", () => {
    expect([...createInitialDockTabVisited("a")]).toEqual(["a"]);
    expect(createInitialDockTabVisited(null).size).toBe(0);
  });

  it("幂等追加", () => {
    const once = markDockTabVisited(new Set(["a"]), "b");
    expect(once.has("a") && once.has("b")).toBe(true);
    const twice = markDockTabVisited(once, "b");
    expect(twice).toBe(once);
  });
});
