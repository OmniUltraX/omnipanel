import { describe, expect, it } from "vitest";
import {
  parseQuickLaunchQuery,
  registerLauncherProvider,
  unregisterLauncherProvider,
} from "./quickLauncherMatch";

describe("parseQuickLaunchQuery", () => {
  it("keeps ssh+ and db prefix behavior", () => {
    expect(parseQuickLaunchQuery("ssh+web")).toEqual({
      kind: "ssh",
      raw: "ssh+web",
      filter: "web",
    });
    expect(parseQuickLaunchQuery("db")).toMatchObject({ kind: "db", filter: "" });
    expect(parseQuickLaunchQuery("db prod.users")).toMatchObject({
      kind: "db",
      filter: "prod.users",
      databaseHint: "prod",
      tableHint: "users",
    });
  });

  it("es prefix comes from plugin registration, not builtin", () => {
    // 插件未激活：es 前缀不存在，退化为普通查询
    expect(parseQuickLaunchQuery("es ext:yml").kind).toBe("plain");

    // 模拟 addon-everything activate 登记
    registerLauncherProvider({
      prefix: "es",
      parse: (raw, filter) => ({ kind: "es", raw, filter }),
    });
    expect(parseQuickLaunchQuery("es ext:yml")).toEqual({
      kind: "es",
      raw: "es ext:yml",
      filter: "ext:yml",
    });

    // deactivate 卸除后回到 plain
    unregisterLauncherProvider("es");
    expect(parseQuickLaunchQuery("es foo").kind).toBe("plain");

    // 恢复登记，避免影响其他用例对内核前缀的假设
    registerLauncherProvider({
      prefix: "es",
      parse: (raw, filter) => ({ kind: "es", raw, filter }),
    });
    expect(parseQuickLaunchQuery("es foo").kind).toBe("es");
  });
});
