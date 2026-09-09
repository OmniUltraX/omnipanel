import { describe, expect, it } from "vitest";
import {
  buildSandboxDoc,
  formatSandboxBridgeBlockLog,
  sandboxBridgeDenyReason,
} from "./PluginSandboxFrame";

describe("PluginSandboxFrame", () => {
  it("注入插件 HTML 与 CSP", () => {
    const html = '<div id="plugin-root">hello overlay</div>';
    const doc = buildSandboxDoc(html);
    expect(doc).toContain("hello overlay");
    expect(doc).toContain("Content-Security-Policy");
    expect(doc).toContain("default-src 'none'");
  });

  it("越权与白名单外给出拒绝文案", () => {
    const none = new Set<string>();
    expect(sandboxBridgeDenyReason("netFetch", none)).toBe("缺权限 net:connect");
    expect(sandboxBridgeDenyReason("eval", none)).toBe("白名单外的方法: eval");
    expect(sandboxBridgeDenyReason("invoke", none)).toBeNull();
    expect(sandboxBridgeDenyReason("netFetch", new Set(["net:connect"]))).toBeNull();
  });

  it("blocked 日志格式", () => {
    expect(
      formatSandboxBridgeBlockLog("omni.sample.overlay", "netFetch", "缺权限 net:connect"),
    ).toBe("[plugin-bridge] blocked omni.sample.overlay netFetch: 缺权限 net:connect");
  });
});
