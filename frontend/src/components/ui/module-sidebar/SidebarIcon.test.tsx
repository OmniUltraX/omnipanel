import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SidebarIcon, type SidebarIconKind } from "./SidebarIcon";

const ALL_KINDS: SidebarIconKind[] = [
  "folder",
  "document",
  "connection",
  "host",
  "database",
  "container",
  "key",
  "tunnel",
];

describe("SidebarIcon", () => {
  it.each(ALL_KINDS)("kind=%s 锁死 14px 且对读屏隐藏", (kind) => {
    const { container } = render(<SidebarIcon kind={kind} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("width")).toBe("14");
    expect(svg?.getAttribute("height")).toBe("14");
    expect(svg?.getAttribute("stroke-width")).toBe("1.8");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });

  it("folder 复用既有路径（迁移前后视觉不变）", () => {
    const { container } = render(<SidebarIcon kind="folder" />);
    expect(container.querySelector("path")?.getAttribute("d")).toContain("M22 19");
  });
});
