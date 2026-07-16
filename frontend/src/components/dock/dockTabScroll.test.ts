import { describe, expect, it } from "vitest";
import { findDockTabElement, scrollDockTabIntoView } from "./dockTabScroll";

describe("dockTabScroll", () => {
  it("finds tab element by data-dock-tab-id", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div class="dv-tabs-container" style="width:100px;overflow:auto">
        <div class="dv-tab">
          <div class="dv-default-tab" data-dock-tab-id="t1">A</div>
        </div>
      </div>
    `;
    const tab = findDockTabElement(root, "t1");
    expect(tab?.classList.contains("dv-tab")).toBe(true);
    expect(scrollDockTabIntoView(root, "t1")).toBe(true);
    expect(scrollDockTabIntoView(root, "missing")).toBe(false);
  });
});
