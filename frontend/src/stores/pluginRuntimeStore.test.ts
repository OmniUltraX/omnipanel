import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listenMock, pluginListMock, syncLifecyclesMock, pluginManifestsIpcMock } = vi.hoisted(() => ({
  listenMock: vi.fn(),
  pluginListMock: vi.fn(),
  syncLifecyclesMock: vi.fn(),
  pluginManifestsIpcMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

// 保持 store 测试封闭：Loader 生命周期语义由 pluginRuntimeLoader.test.ts 覆盖
vi.mock("../lib/pluginRuntimeLoader", () => ({
  ensurePluginContributionsLoaded: () => undefined,
  syncPluginLifecycles: (...args: unknown[]) => syncLifecyclesMock(...args),
}));

vi.mock("../ipc/bindings", () => ({
  commands: {
    pluginList: () => pluginListMock(),
    pluginManifests: () => pluginManifestsIpcMock(),
  },
}));

import {
  initPluginRuntimeStore,
  resetPluginRuntimeSubscriptionForTests,
  subscribePluginRuntimeChanged,
  usePluginRuntimeStore,
} from "./pluginRuntimeStore";

describe("pluginRuntimeStore 跨窗口订阅", () => {
  beforeEach(() => {
    resetPluginRuntimeSubscriptionForTests();
    listenMock.mockReset();
    pluginListMock.mockReset();
    syncLifecyclesMock.mockReset();
    pluginManifestsIpcMock.mockReset();
    syncLifecyclesMock.mockResolvedValue(undefined);
    pluginManifestsIpcMock.mockRejectedValue(new Error("not mocked"));
    usePluginRuntimeStore.setState({ items: [], hydrated: false });
    listenMock.mockResolvedValue(() => undefined);
    pluginListMock.mockResolvedValue({
      status: "ok",
      data: [
        {
          id: "omni.module.nacos",
          version: "0.1.0",
          kind: "module",
          enabled: true,
          activated: true,
        },
      ],
    });
  });

  afterEach(() => {
    resetPluginRuntimeSubscriptionForTests();
  });

  it("init 时只订阅一次 plugin://changed", async () => {
    await initPluginRuntimeStore();
    await initPluginRuntimeStore();
    expect(listenMock).toHaveBeenCalledTimes(1);
    expect(listenMock.mock.calls[0]?.[0]).toBe("plugin://changed");
  });

  it("收到事件后 reload plugin_list", async () => {
    let handler: (() => void) | undefined;
    listenMock.mockImplementation(async (_event: string, cb: () => void) => {
      handler = cb;
      return () => undefined;
    });
    await subscribePluginRuntimeChanged();
    pluginListMock.mockResolvedValue({
      status: "ok",
      data: [
        {
          id: "omni.module.nacos",
          version: "0.1.0",
          kind: "module",
          enabled: false,
          activated: false,
        },
      ],
    });
    handler?.();
    await vi.waitFor(() => {
      expect(usePluginRuntimeStore.getState().items[0]?.enabled).toBe(false);
    });
  });

  it("reload 灌入磁盘安装清单且 IPC 失败时保留上次结果", async () => {
    const { listInstalledPluginManifests, setInstalledPluginManifests } = await import(
      "../lib/pluginManifests"
    );
    setInstalledPluginManifests([]);
    pluginListMock.mockResolvedValue({ status: "ok", data: [] });
    pluginManifestsIpcMock.mockResolvedValue({
      status: "ok",
      data: [
        {
          id: "omni.engine.l1-starter",
          version: "0.1.0",
          kind: "engine",
          enabled: true,
          activated: true,
          source: "installed",
          manifestJson: JSON.stringify({
            id: "omni.engine.l1-starter",
            version: "0.1.0",
            kind: "engine",
          }),
        },
        {
          id: "omni.engine.redis",
          version: "0.1.0",
          kind: "engine",
          enabled: true,
          activated: true,
          source: "builtin",
          manifestJson: JSON.stringify({
            id: "omni.engine.redis",
            version: "0.1.0",
            kind: "engine",
          }),
        },
      ],
    });
    await usePluginRuntimeStore.getState().reload();
    expect(listInstalledPluginManifests().map((m) => m.id)).toEqual([
      "omni.engine.l1-starter",
    ]);

    // IPC 失败：保留上次合并结果，不回退为空
    pluginManifestsIpcMock.mockRejectedValue(new Error("boom"));
    await usePluginRuntimeStore.getState().reload();
    expect(listInstalledPluginManifests()).toHaveLength(1);
    setInstalledPluginManifests([]);
  });
});
