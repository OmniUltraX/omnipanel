import { describe, expect, it } from "vitest";
import { Orientation } from "dockview-core";
import type { SerializedDockview } from "dockview-core";
import { createDefaultLayout, normalizeDockLayout } from "./dockViewLayout";
import {
  resolveDockWindowChromeLayout,
  resolveSegmentWindowChromeHosts,
} from "./dockWindowChromeLayout";

function panelEntry(id: string): NonNullable<SerializedDockview["panels"]>[string] {
  return {
    id,
    contentComponent: "dockable-content",
    title: id,
    params: { tabId: id },
  };
}

/** dockview 从默认 HORIZONTAL 根拖到下方时：根方向不变，内层 branch 才是上下分栏 */
function nestedVerticalSplit(
  top: { id: string; views: string[] },
  bottom: { id: string; views: string[] },
): SerializedDockview {
  const views = [...top.views, ...bottom.views];
  return {
    grid: {
      orientation: Orientation.HORIZONTAL,
      width: 1000,
      height: 600,
      root: {
        type: "branch",
        data: [
          {
            type: "branch",
            data: [
              {
                type: "leaf",
                data: { id: top.id, views: top.views, activeView: top.views[0] },
                size: 500,
              },
              {
                type: "leaf",
                data: {
                  id: bottom.id,
                  views: bottom.views,
                  activeView: bottom.views[0],
                },
                size: 500,
              },
            ],
            size: 1000,
          },
        ],
      } as SerializedDockview["grid"]["root"],
    },
    panels: Object.fromEntries(views.map((id) => [id, panelEntry(id)])),
    activeGroup: top.id,
  };
}

function splitLayout(
  orientation: Orientation,
  left: { id: string; views: string[] },
  right: { id: string; views: string[] },
): SerializedDockview {
  const views = [...left.views, ...right.views];
  return {
    grid: {
      orientation,
      width: 1000,
      height: 600,
      root: {
        type: "branch",
        data: [
          {
            type: "leaf",
            data: { id: left.id, views: left.views, activeView: left.views[0] },
            size: 500,
          },
          {
            type: "leaf",
            data: { id: right.id, views: right.views, activeView: right.views[0] },
            size: 500,
          },
        ],
      } as SerializedDockview["grid"]["root"],
    },
    panels: Object.fromEntries(views.map((id) => [id, panelEntry(id)])),
    activeGroup: left.id,
  };
}

describe("resolveSegmentWindowChromeHosts", () => {
  it("单 group 时 drag 与窗控都挂在该 group", () => {
    const layout = createDefaultLayout(["tab-a", "tab-b"], "tab-a");
    const groupId = layout.activeGroup ?? "group-tab-a";
    expect(resolveSegmentWindowChromeHosts([groupId], layout)).toEqual({
      dragGroupId: groupId,
      controlsGroupId: groupId,
    });
  });

  it("左右分屏时窗控挂到右侧 group，拖拽区留在左侧", () => {
    const layout = splitLayout(
      Orientation.HORIZONTAL,
      { id: "g-left", views: ["tab-a"] },
      { id: "g-right", views: ["tab-b"] },
    );
    expect(
      resolveSegmentWindowChromeHosts(["g-left", "g-right"], layout),
    ).toEqual({
      dragGroupId: "g-left",
      controlsGroupId: "g-right",
    });
  });

  it("上下分屏时 drag 与窗控都留在顶部 group", () => {
    const layout = splitLayout(
      Orientation.VERTICAL,
      { id: "g-top", views: ["tab-a"] },
      { id: "g-bottom", views: ["tab-b"] },
    );
    expect(
      resolveSegmentWindowChromeHosts(["g-top", "g-bottom"], layout),
    ).toEqual({
      dragGroupId: "g-top",
      controlsGroupId: "g-top",
    });
  });

  it("默认横向根下拖到下方时，窗控仍挂顶部而不是下栏", () => {
    const layout = nestedVerticalSplit(
      { id: "g-top", views: ["tab-a"] },
      { id: "g-bottom", views: ["tab-b"] },
    );
    expect(
      resolveSegmentWindowChromeHosts(["g-top", "g-bottom"], layout),
    ).toEqual({
      dragGroupId: "g-top",
      controlsGroupId: "g-top",
    });
  });

  it("normalize 后上下分栏仍把窗控留在顶部", () => {
    const layout = nestedVerticalSplit(
      { id: "g-top", views: ["tab-a"] },
      { id: "g-bottom", views: ["tab-b"] },
    );
    const normalized = normalizeDockLayout(layout);
    expect(
      resolveSegmentWindowChromeHosts(["g-top", "g-bottom"], normalized),
    ).toEqual({
      dragGroupId: "g-top",
      controlsGroupId: "g-top",
    });
  });

  it("layout 缺失时回退到第一个 group，避免窗控消失", () => {
    expect(resolveSegmentWindowChromeHosts(["g-left", "g-right"])).toEqual({
      dragGroupId: "g-left",
      controlsGroupId: "g-left",
    });
  });

  it("layout 中的 group id 对不上 live groups 时回退第一个", () => {
    const layout = splitLayout(
      Orientation.HORIZONTAL,
      { id: "stale-left", views: ["tab-a"] },
      { id: "stale-right", views: ["tab-b"] },
    );
    expect(resolveSegmentWindowChromeHosts(["g-left", "g-right"], layout)).toEqual({
      dragGroupId: "g-left",
      controlsGroupId: "g-left",
    });
  });
});

describe("resolveDockWindowChromeLayout", () => {
  it("左右分屏时右上角 group 承载窗控", () => {
    const layout = splitLayout(
      Orientation.HORIZONTAL,
      { id: "g-left", views: ["tab-a"] },
      { id: "g-right", views: ["tab-b"] },
    );
    const chrome = resolveDockWindowChromeLayout(layout);
    expect(chrome?.dragGroupId).toBe("g-left");
    expect(chrome?.controlsGroupId).toBe("g-right");
  });
});
