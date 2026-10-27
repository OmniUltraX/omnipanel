import { describe, expect, it } from "vitest";
import type { DockableTab } from "./dockableTab";
import {
  buildDockTabOverflowSections,
  dockTabOverflowSubtitle,
  isTabFullyVisible,
  measureGroupTabs,
  presentDockOverflowTab,
} from "./dockTabOverflowModel";
import type { DockTabOverflowTab } from "./dockTabOverflowModel";

function tab(
  partial: Pick<DockTabOverflowTab, "id" | "panelType" | "label"> &
    Partial<DockTabOverflowTab>,
): DockTabOverflowTab {
  return {
    tooltip: partial.label,
    overflowed: false,
    closable: true,
    ...partial,
  };
}

const identity = (panelType: string) => panelType;

describe("buildDockTabOverflowSections", () => {
  it("单一类型且有的在栏上、有的被裁切时，只显示两段标题", () => {
    const sections = buildDockTabOverflowSections(
      [
        tab({ id: "a", panelType: "terminal-session", label: "本地", overflowed: true }),
        tab({ id: "b", panelType: "terminal-session", label: "跳板", overflowed: false }),
      ],
      "",
      [],
      identity,
    );
    expect(sections.map((section) => section.bucket)).toEqual(["overflow", "visible"]);
    expect(sections.every((section) => section.groupLabel == null)).toBe(true);
    expect(sections[0]?.items.map((item) => item.id)).toEqual(["a"]);
    expect(sections[1]?.items.map((item) => item.id)).toEqual(["b"]);
  });

  it("分组模式按出现顺序分组，组内保持标签栏顺序", () => {
    const sections = buildDockTabOverflowSections(
      [
        tab({ id: "t1", panelType: "terminal", label: "甲", overflowed: true }),
        tab({ id: "d1", panelType: "database", label: "库", overflowed: true }),
        tab({ id: "t2", panelType: "terminal", label: "乙", overflowed: true }),
      ],
      "",
      ["t2", "d1", "t1"],
      identity,
      "group",
    );
    expect(sections.map((section) => section.groupLabel)).toEqual(["terminal", "database"]);
    expect(sections.every((section) => section.bucket == null)).toBe(true);
    expect(sections[0]?.items.map((item) => item.id)).toEqual(["t1", "t2"]);
    expect(sections[1]?.items.map((item) => item.id)).toEqual(["d1"]);
  });

  it("最近使用模式排成一列，不分组", () => {
    const sections = buildDockTabOverflowSections(
      [
        tab({ id: "t1", panelType: "terminal", label: "甲", overflowed: true }),
        tab({ id: "d1", panelType: "database", label: "库", overflowed: false }),
        tab({ id: "t2", panelType: "terminal", label: "乙", overflowed: true }),
      ],
      "",
      ["t2", "d1", "t1"],
      identity,
      "recent",
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]?.groupLabel).toBeUndefined();
    expect(sections[0]?.bucket).toBeUndefined();
    expect(sections[0]?.items.map((item) => item.id)).toEqual(["t2", "d1", "t1"]);
  });

  it("顺序模式不分组，仍按是否露出分段", () => {
    const sections = buildDockTabOverflowSections(
      [
        tab({ id: "a", panelType: "terminal", label: "甲", overflowed: true }),
        tab({ id: "b", panelType: "database", label: "库", overflowed: false }),
      ],
      "",
      [],
      identity,
      "order",
    );
    expect(sections.map((section) => section.groupLabel)).toEqual([undefined, undefined]);
    expect(sections[0]?.items.map((item) => item.id)).toEqual(["a"]);
    expect(sections[1]?.items.map((item) => item.id)).toEqual(["b"]);
  });

  it("搜索命中标题、提示或分组名，并取消未显示分段", () => {
    const sections = buildDockTabOverflowSections(
      [
        tab({
          id: "q",
          panelType: "database-sql",
          label: "crm_migration",
          tooltip: "查询订单",
          overflowed: true,
        }),
        tab({
          id: "h",
          panelType: "ssh-host",
          label: "118.190.202.45",
          overflowed: false,
        }),
      ],
      "SQL",
      [],
      (panelType) => (panelType === "database-sql" ? "SQL 查询" : panelType),
      "group",
    );
    expect(sections).toHaveLength(1);
    expect(sections[0]?.bucket).toBeUndefined();
    expect(sections[0]?.groupLabel).toBeUndefined();
    expect(sections[0]?.items.map((item) => item.id)).toEqual(["q"]);
  });

  it("没有命中时返回空", () => {
    expect(
      buildDockTabOverflowSections(
        [tab({ id: "a", panelType: "ssh-host", label: "host" })],
        "zzz",
        [],
        identity,
        "group",
      ),
    ).toEqual([]);
  });

  it("拼音能命中中文标题和备注", () => {
    const sections = buildDockTabOverflowSections(
      [
        tab({
          id: "q",
          panelType: "database-sql",
          label: "订单查询",
          note: "生产库",
          overflowed: true,
        }),
      ],
      "sc",
      [],
      identity,
      "order",
    );
    expect(sections[0]?.items.map((item) => item.id)).toEqual(["q"]);
    expect(
      dockTabOverflowSubtitle({ label: "订单查询", note: "生产库", detail: "10.0.0.1:3306" }),
    ).toBe("生产库 · 10.0.0.1:3306");
  });
});

describe("presentDockOverflowTab", () => {
  it("用实时元数据覆盖标题、图标和文件保存态", () => {
    const source: DockableTab = {
      id: "f",
      label: "旧名",
      panelType: "database-sql",
      type: "file",
      dirty: false,
      saved: true,
      icon: "sql",
    };
    const presented = presentDockOverflowTab(source, true, {
      rev: 2,
      label: "新名",
      type: "file",
      dirty: true,
      saved: false,
      icon: "table",
      preview: true,
    });
    expect(presented.label).toBe("新名");
    expect(presented.icon).toBe("table");
    expect(presented.dirty).toBe(true);
    expect(presented.saved).toBe(false);
    expect(presented.preview).toBe(true);
    expect(presented.overflowed).toBe(true);
  });
});

describe("measureGroupTabs", () => {
  it("只量当前分组的标签栏，跳过隐藏标签，并标出未完整露出的项", () => {
    const group = document.createElement("div");
    group.className = "dv-groupview";
    group.innerHTML = `
      <div class="dv-tabs-and-actions-container">
        <div class="dv-tabs-container">
          <div class="dv-tab" data-tab-id="visible"></div>
          <div class="dv-tab" data-tab-id="clipped"></div>
          <div class="dv-tab dock-tab--bar-hidden" data-tab-id="hidden"></div>
        </div>
      </div>
      <div class="dv-content-container">
        <div class="dv-groupview">
          <div class="dv-tabs-and-actions-container">
            <div class="dv-tabs-container">
              <div class="dv-tab" data-tab-id="nested"></div>
            </div>
          </div>
        </div>
      </div>
    `;
    const container = group.querySelector<HTMLElement>(":scope > .dv-tabs-and-actions-container .dv-tabs-container");
    const [visible, clipped] = container?.querySelectorAll<HTMLElement>(":scope > .dv-tab") ?? [];
    if (!container || !visible || !clipped) throw new Error("fixture missing");
    container.getBoundingClientRect = () =>
      ({ left: 0, right: 100, top: 0, bottom: 28, width: 100, height: 28 }) as DOMRect;
    visible.getBoundingClientRect = () =>
      ({ left: 0, right: 40, top: 0, bottom: 28, width: 40, height: 28 }) as DOMRect;
    clipped.getBoundingClientRect = () =>
      ({ left: 80, right: 140, top: 0, bottom: 28, width: 60, height: 28 }) as DOMRect;

    expect(measureGroupTabs(group)).toEqual([
      { id: "visible", overflowed: false },
      { id: "clipped", overflowed: true },
    ]);
    expect(isTabFullyVisible(clipped, container)).toBe(false);
  });
});
