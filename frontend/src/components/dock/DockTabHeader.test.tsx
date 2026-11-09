import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DockTabHeader } from "./DockTabHeader";
import type { IDockviewPanelHeaderProps } from "dockview-react";

// Mock i18n
vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => {
      if (key === "ui.dockTab.unsavedChanges") return "有未保存修改";
      return key;
    },
  }),
}));

// Mock other hooks
vi.mock("./dockTabLiveMeta", () => ({
  useDockTabLiveMeta: () => ({ rev: 0 }),
}));

vi.mock("./dockTabHeaderRuntime", () => ({
  useDockTabHeaderRuntime: () => null,
}));

vi.mock("./useDockTabBarHidden", () => ({
  useDockTabBarHidden: () => ({ current: null }),
}));

describe("DockTabHeader", () => {
  const createMockApi = (): IDockviewPanelHeaderProps["api"] => ({
    id: "test-tab",
    title: "Test Tab",
    close: vi.fn(),
    group: {
      api: {
        getHeaderPosition: () => "top",
      },
    },
  } as unknown as IDockviewPanelHeaderProps["api"]);

  it("不显示状态标记当 tab 为已保存的 SQL 文件", () => {
    const api = createMockApi();
    const { container } = render(
      <DockTabHeader
        api={api}
        params={{
          tabId: "test-tab",
          label: "query.sql",
          type: "file",
          dirty: false,
          saved: true,
        }}
      />,
    );

    // 不应该显示任何状态标记
    expect(container.querySelector(".dock-tab-dirty")).toBeNull();
    expect(container.querySelector(".dock-tab-saved")).toBeNull();
  });

  it("显示中性色未保存标记当 tab 有未保存修改", () => {
    const api = createMockApi();
    render(
      <DockTabHeader
        api={api}
        params={{
          tabId: "test-tab",
          label: "query.sql",
          type: "file",
          dirty: true,
        }}
      />,
    );

    // 应该显示 dirty 标记
    const dirtyMark = screen.getByLabelText("有未保存修改");
    expect(dirtyMark).toHaveClass("dock-tab-dirty");
    expect(dirtyMark).toHaveAttribute("title", "有未保存修改");
  });

  it("不显示状态标记当 tab 为新建未保存文件", () => {
    const api = createMockApi();
    const { container } = render(
      <DockTabHeader
        api={api}
        params={{
          tabId: "test-tab",
          label: "未命名",
          type: "file",
          dirty: false,
          saved: false,
        }}
      />,
    );

    // 不应该显示任何状态标记
    expect(container.querySelector(".dock-tab-dirty")).toBeNull();
    expect(container.querySelector(".dock-tab-saved")).toBeNull();
  });

  it("不显示状态标记当 tab 不是文件类型", () => {
    const api = createMockApi();
    const { container } = render(
      <DockTabHeader
        api={api}
        params={{
          tabId: "test-tab",
          label: "数据库连接",
        }}
      />,
    );

    // 不应该显示任何状态标记
    expect(container.querySelector(".dock-tab-dirty")).toBeNull();
    expect(container.querySelector(".dock-tab-saved")).toBeNull();
  });

  it("在侧边栏模式下也正确显示未保存标记", () => {
    const api = {
      ...createMockApi(),
      group: {
        api: {
          getHeaderPosition: () => "left",
        },
      },
    } as unknown as IDockviewPanelHeaderProps["api"];

    render(
      <DockTabHeader
        api={api}
        params={{
          tabId: "test-tab",
          label: "query.sql",
          type: "file",
          dirty: true,
        }}
      />,
    );

    // 应该显示带 --side 修饰符的 dirty 标记
    const dirtyMark = screen.getByLabelText("有未保存修改");
    expect(dirtyMark).toHaveClass("dock-tab-dirty");
    expect(dirtyMark).toHaveClass("dock-tab-dirty--side");
  });
});
