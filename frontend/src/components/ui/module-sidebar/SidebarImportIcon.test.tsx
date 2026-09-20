import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SidebarImportIcon } from "./SidebarImportIcon";
import { SidebarRefreshIcon } from "./SidebarRefreshIcon";

describe("SidebarImportIcon", () => {
  it("锁死 12px 且对读屏隐藏", () => {
    const { container } = render(<SidebarImportIcon />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("12");
    expect(svg?.getAttribute("height")).toBe("12");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });

  it("与刷新图标路径不同（导入 ≠ 下载/刷新）", () => {
    const { container: importBox } = render(<SidebarImportIcon />);
    const { container: refreshBox } = render(<SidebarRefreshIcon />);
    const importPaths = [...importBox.querySelectorAll("path")]
      .map((p) => p.getAttribute("d"))
      .join("|");
    const refreshPaths = [...refreshBox.querySelectorAll("path")]
      .map((p) => p.getAttribute("d"))
      .join("|");
    expect(importPaths).not.toBe(refreshPaths);
    // 敞口托盘：必须有 U 形收纳笔触，而非下载式一横线
    expect(importPaths).toContain("M5 12v7h14v-7");
  });
});
