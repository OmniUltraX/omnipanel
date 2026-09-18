import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModuleSidebarTreeToolbar } from "./ModuleSidebarTreeToolbar";

describe("ModuleSidebarTreeToolbar", () => {
  it("固定顺序渲染刷新→展开/折叠", () => {
    const { container, rerender } = render(
      <ModuleSidebarTreeToolbar
        onRefresh={vi.fn()}
        onExpandAll={vi.fn()}
        onCollapseAll={vi.fn()}
      />,
    );
    // 有可收节点 → 只显示折叠
    expect([...container.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual([
      "刷新",
      "全部折叠",
    ]);
    // 全收起 → 只显示展开
    rerender(
      <ModuleSidebarTreeToolbar
        onRefresh={vi.fn()}
        onExpandAll={vi.fn()}
        onCollapseAll={vi.fn()}
        collapseDisabled
      />,
    );
    expect([...container.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual([
      "刷新",
      "全部展开",
    ]);
  });

  it("无 handler 的刷新置灰而非缺失（段头按钮位对齐）", () => {
    render(<ModuleSidebarTreeToolbar onExpandAll={vi.fn()} collapseDisabled />);
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    // 刷新无 handler → 禁用占位
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).not.toBeDisabled();
  });

  it("点击阻止冒泡并触发回调", () => {
    const onCollapseAll = vi.fn();
    const onParent = vi.fn();
    render(
      <div onClick={onParent}>
        <ModuleSidebarTreeToolbar onCollapseAll={onCollapseAll} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "全部折叠" }));
    expect(onCollapseAll).toHaveBeenCalledTimes(1);
    expect(onParent).not.toHaveBeenCalled();
  });

  it("refreshing 时刷新按钮转圈且禁用", () => {
    render(<ModuleSidebarTreeToolbar onRefresh={vi.fn()} refreshing />);
    const btn = screen.getByRole("button", { name: "刷新" });
    expect(btn).toBeDisabled();
    expect(btn.className).toContain("tree-action-btn--busy");
  });
});
