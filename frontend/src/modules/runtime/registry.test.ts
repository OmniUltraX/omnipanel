import { describe, expect, it, beforeEach } from "vitest";
import {
  clearModuleRegistryForTests,
  getModule,
  listModules,
  registerModule,
  unregisterModule,
} from "./registry";
import type { ModuleDescriptor } from "./types";

function stubDescriptor(
  id: ModuleDescriptor["id"],
  path = `/module/${id}`,
): ModuleDescriptor {
  return {
    id,
    path,
    keepLayout: true,
    keepAlive: { recentEligible: true },
    loadView: async () => ({ default: () => null }),
  };
}

describe("module runtime registry", () => {
  beforeEach(() => {
    clearModuleRegistryForTests();
  });

  it("注册后可按 id 查询", () => {
    registerModule(stubDescriptor("terminal"));
    expect(getModule("terminal")?.path).toBe("/module/terminal");
  });

  it("listModules 保持注册顺序", () => {
    registerModule(stubDescriptor("ssh"));
    registerModule(stubDescriptor("docker"));
    expect(listModules().map((m) => m.id)).toEqual(["ssh", "docker"]);
  });

  it("重复注册覆盖条目", () => {
    registerModule(stubDescriptor("terminal", "/module/terminal"));
    registerModule(stubDescriptor("terminal", "/module/terminal-v2"));
    expect(getModule("terminal")?.path).toBe("/module/terminal-v2");
    expect(listModules()).toHaveLength(1);
  });

  it("注销后不可再查", () => {
    registerModule(stubDescriptor("cloud"));
    expect(unregisterModule("cloud")).toBe(true);
    expect(getModule("cloud")).toBeUndefined();
    expect(unregisterModule("cloud")).toBe(false);
  });
});
