import { beforeEach, describe, expect, it, vi } from "vitest";

const { appModuleListMock } = vi.hoisted(() => ({
  appModuleListMock: vi.fn(),
}));

vi.mock("../ipc/bindings", () => ({
  commands: {
    appModuleList: () => appModuleListMock(),
    appModuleSetStatus: vi.fn(),
  },
}));

import { getNavVisibleModuleKeys, useAppModuleStore } from "./appModuleStore";
import { usePluginRuntimeStore } from "./pluginRuntimeStore";

describe("appModuleStore 插件模块侧栏", () => {
  beforeEach(() => {
    appModuleListMock.mockReset();
    useAppModuleStore.setState({ modules: [], hydrated: false });
    usePluginRuntimeStore.setState({
      items: [
        {
          id: "omni.module.nacos",
          version: "0.2.0",
          kind: "module",
          enabled: true,
          activated: true,
          source: "builtin",
          unsupportedReason: null,
        },
      ],
      hydrated: true,
    });
  });

  it("已启用的 module 插件在尚未入库时出现在侧栏", () => {
    useAppModuleStore.setState({ modules: [], hydrated: true });
    expect(getNavVisibleModuleKeys()).toContain("nacos");
  });

  it("用户在设置中关闭后不再出现在侧栏", () => {
    useAppModuleStore.setState({
      hydrated: true,
      modules: [
        { module_key: "terminal", status: "open", sort_order: 0 },
        { module_key: "nacos", status: "closed", sort_order: 80 },
      ],
    });
    expect(getNavVisibleModuleKeys()).not.toContain("nacos");
  });

  it("refresh 会重新拉取模块列表", async () => {
    appModuleListMock.mockResolvedValue({
      status: "ok",
      data: [{ module_key: "nacos", status: "open", sort_order: 80 }],
    });
    await useAppModuleStore.getState().refresh();
    expect(useAppModuleStore.getState().modules).toEqual([
      { module_key: "nacos", status: "open", sort_order: 80 },
    ]);
    expect(getNavVisibleModuleKeys()).toContain("nacos");
  });
});
