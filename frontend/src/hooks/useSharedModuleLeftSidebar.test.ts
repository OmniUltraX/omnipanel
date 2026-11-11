import { describe, expect, it } from "vitest";
import { MODULE_LEFT_SIDEBAR_MIN_PX } from "../stores/panelLayoutStore";
import { sharedModuleLeftSidebarApplySucceeded } from "./useSharedModuleLeftSidebar";

describe("sharedModuleLeftSidebarApplySucceeded", () => {
  it("rejects a first-layout 0-width expand so the hook keeps retrying", () => {
    expect(sharedModuleLeftSidebarApplySucceeded(false, 0, false)).toBe(false);
    expect(sharedModuleLeftSidebarApplySucceeded(false, 54, false)).toBe(false);
    expect(sharedModuleLeftSidebarApplySucceeded(false, undefined, false)).toBe(false);
  });

  it("accepts a usable width or an intentional collapse", () => {
    expect(sharedModuleLeftSidebarApplySucceeded(false, MODULE_LEFT_SIDEBAR_MIN_PX, false)).toBe(true);
    expect(sharedModuleLeftSidebarApplySucceeded(false, 260, false)).toBe(true);
    expect(sharedModuleLeftSidebarApplySucceeded(true, 0, true)).toBe(true);
  });

  it("does not treat a collapsed handle as a successful expand", () => {
    expect(sharedModuleLeftSidebarApplySucceeded(false, 0, true)).toBe(false);
    expect(sharedModuleLeftSidebarApplySucceeded(true, 260, false)).toBe(false);
  });
});
