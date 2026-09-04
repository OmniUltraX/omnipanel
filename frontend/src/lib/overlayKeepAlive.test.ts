import { describe, expect, it } from "vitest";
import {
  collectPinnedKeepAliveIds,
  createInitialKeepAliveState,
  overlayMountedRecordFromKeepAlive,
  pluginKeysFromKeepAlive,
  resolveOverlayKeepAliveMounted,
  touchOverlayKeepAlive,
} from "./overlayKeepAlive";
import type { WorkspaceDockTab } from "../stores/workspaceBottomDockStore";

describe("overlayKeepAlive", () => {
  it("初始仅挂载当前路由模块", () => {
    const state = createInitialKeepAliveState("/module/ssh");
    expect(state).toEqual({ current: "ssh", recent: [] });
    const mounted = resolveOverlayKeepAliveMounted(state);
    expect([...mounted]).toEqual(["ssh"]);
  });

  it("切换后保留当前 + 最近 1 个", () => {
    let state = createInitialKeepAliveState("/module/ssh");
    state = touchOverlayKeepAlive(state, "docker");
    expect(state).toEqual({ current: "docker", recent: ["ssh"] });

    state = touchOverlayKeepAlive(state, "database");
    expect(state).toEqual({ current: "database", recent: ["docker"] });

    const mounted = resolveOverlayKeepAliveMounted(state);
    expect(mounted.has("database")).toBe(true);
    expect(mounted.has("docker")).toBe(true);
    expect(mounted.has("ssh")).toBe(false);
  });

  it("回到最近模块时不重复堆叠 recent", () => {
    let state = createInitialKeepAliveState("/module/ssh");
    state = touchOverlayKeepAlive(state, "docker");
    state = touchOverlayKeepAlive(state, "ssh");
    expect(state).toEqual({ current: "ssh", recent: ["docker"] });
  });

  it("进入看板时 current 为空，仍保留最近 1 个", () => {
    let state = createInitialKeepAliveState("/module/cloud");
    state = touchOverlayKeepAlive(state, null);
    expect(state).toEqual({ current: null, recent: ["cloud"] });
  });

  it("pinned 模块始终保留", () => {
    let state = createInitialKeepAliveState("/module/ssh");
    state = touchOverlayKeepAlive(state, "docker");
    state = touchOverlayKeepAlive(state, "server");
    const mounted = resolveOverlayKeepAliveMounted(state, new Set(["database"]));
    expect(mounted.has("server")).toBe(true);
    expect(mounted.has("docker")).toBe(true);
    expect(mounted.has("database")).toBe(true);
    expect(mounted.has("ssh")).toBe(false);
  });

  it("插件模块同样走 LRU", () => {
    let state = createInitialKeepAliveState("/module/nacos");
    expect(state.current).toBe("plugin:nacos");
    state = touchOverlayKeepAlive(state, "cloud");
    expect(state).toEqual({
      current: "cloud",
      recent: ["plugin:nacos"],
    });
    state = touchOverlayKeepAlive(state, "plugin:other");
    expect(state).toEqual({
      current: "plugin:other",
      recent: ["cloud"],
    });
    const mounted = resolveOverlayKeepAliveMounted(state);
    expect(pluginKeysFromKeepAlive(mounted)).toEqual(["other"]);
    expect(overlayMountedRecordFromKeepAlive(mounted).cloud).toBe(true);
  });

  it("工作区镜像 Tab 会 pin database/terminal", () => {
    const dbTab: WorkspaceDockTab = {
      id: "t1",
      label: "db",
      kind: "mirrored",
      originScope: "database",
      originPanelId: "p1",
    };
    const pinned = collectPinnedKeepAliveIds({ ws1: [dbTab] });
    expect(pinned.has("database")).toBe(true);
  });
});
