import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isModuleDataWarmDone,
  listModuleDataWarmKeys,
  registerModuleDataWarm,
  resetModuleDataWarmForTests,
  scheduleIdleModuleDataWarm,
  shouldSilentDataWarm,
} from "./moduleDataWarm";

beforeEach(() => {
  resetModuleDataWarmForTests();
  window.localStorage.removeItem("omnipanel.warm.datawarm");
});

describe("moduleDataWarm", () => {
  it("同 key 后注册覆盖先注册", () => {
    registerModuleDataWarm("database", async () => {});
    expect(listModuleDataWarmKeys()).toEqual(["database"]);
    registerModuleDataWarm("database", async () => {});
    expect(listModuleDataWarmKeys()).toEqual(["database"]);
  });

  it("kill-switch 关闭时不跑", async () => {
    window.localStorage.setItem("omnipanel.warm.datawarm", "0");
    expect(shouldSilentDataWarm()).toBe(false);
    const ran: string[] = [];
    registerModuleDataWarm("database", async () => {
      ran.push("database");
    });
    const cancel = scheduleIdleModuleDataWarm({ initialTimeoutMs: 0, stepTimeoutMs: 0 });
    await new Promise((r) => setTimeout(r, 20));
    cancel();
    expect(ran).toEqual([]);
    expect(isModuleDataWarmDone("database")).toBe(false);
  });

  it("空闲错峰逐个跑，会话去重，失败隔离", async () => {
    const ran: string[] = [];
    registerModuleDataWarm("database", async () => {
      ran.push("database");
    });
    registerModuleDataWarm("tasks", async () => {
      throw new Error("boom");
    });
    const cancel = scheduleIdleModuleDataWarm({ initialTimeoutMs: 0, stepTimeoutMs: 0 });
    await vi.waitFor(() => {
      expect(ran).toEqual(["database"]);
      expect(isModuleDataWarmDone("database")).toBe(true);
      expect(isModuleDataWarmDone("tasks")).toBe(true);
    });
    cancel();
    // 跑过一次后不再重复
    const cancel2 = scheduleIdleModuleDataWarm({ initialTimeoutMs: 0, stepTimeoutMs: 0 });
    await new Promise((r) => setTimeout(r, 20));
    cancel2();
    expect(ran).toEqual(["database"]);
  });
});
