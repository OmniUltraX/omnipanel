import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listenMock, pluginListMock } = vi.hoisted(() => ({
  listenMock: vi.fn(),
  pluginListMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("../ipc/bindings", () => ({
  commands: {
    pluginList: () => pluginListMock(),
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
});
