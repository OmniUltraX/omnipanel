import { describe, expect, it, beforeEach } from "vitest";
import {
  forgetOverlayContentReady,
  isOverlayVisuallyActive,
  markOverlayContentReady,
  resetOverlayRevealForTests,
  setOverlayRevealTarget,
} from "./overlayReveal";

describe("overlayReveal", () => {
  beforeEach(() => {
    resetOverlayRevealForTests();
  });

  it("holds the previous ready module until the next one is ready", () => {
    setOverlayRevealTarget("dashboard");
    markOverlayContentReady("dashboard");
    expect(isOverlayVisuallyActive("dashboard")).toBe(true);

    setOverlayRevealTarget("database");
    expect(isOverlayVisuallyActive("dashboard")).toBe(true);
    expect(isOverlayVisuallyActive("database")).toBe(false);

    markOverlayContentReady("database");
    expect(isOverlayVisuallyActive("dashboard")).toBe(false);
    expect(isOverlayVisuallyActive("database")).toBe(true);
  });

  it("switches immediately when the target was already ready", () => {
    setOverlayRevealTarget("dashboard");
    markOverlayContentReady("dashboard");
    setOverlayRevealTarget("ssh");
    markOverlayContentReady("ssh");
    setOverlayRevealTarget("dashboard");
    expect(isOverlayVisuallyActive("dashboard")).toBe(true);
    expect(isOverlayVisuallyActive("ssh")).toBe(false);
  });

  it("forgets evicted modules so a remount can hold again", () => {
    setOverlayRevealTarget("files");
    markOverlayContentReady("files");
    forgetOverlayContentReady("files");
    setOverlayRevealTarget("docker");
    expect(isOverlayVisuallyActive("docker")).toBe(true);
  });

  it("hides overlays immediately when the target is cleared", () => {
    setOverlayRevealTarget("dashboard");
    markOverlayContentReady("dashboard");
    setOverlayRevealTarget(null);
    expect(isOverlayVisuallyActive("dashboard")).toBe(false);
  });
});
