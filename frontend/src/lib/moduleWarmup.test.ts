import { describe, expect, it } from "vitest";
import {
  listShellWarmRequested,
  requestModuleShellWarm,
} from "./moduleWarmup";

describe("moduleWarmup 预挂壳", () => {
  it("请求去重且只增", () => {
    const before = listShellWarmRequested().length;
    requestModuleShellWarm("ssh");
    requestModuleShellWarm("ssh");
    requestModuleShellWarm("database");
    const after = listShellWarmRequested();
    expect(after.length).toBe(before + 2);
    expect(after.slice(-2)).toEqual(["ssh", "database"]);
  });
});
