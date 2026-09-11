import { describe, expect, it } from "vitest";
import {
  buildSandboxDoc,
  formatSandboxBridgeBlockLog,
  sandboxBridgeAuditPermission,
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

  it("prelude 透明代理页内 fetch（CSP 下原生必死）", () => {
    const doc = buildSandboxDoc("<div>hi</div>");
    expect(doc).toContain("window.fetch = function");
    expect(doc).toContain("omniFetchResponse");
    // 代理走受闸桥，不直连
    expect(doc).toContain('this.request("netFetch"');
  });

  it("拒绝锚定审计权限（deny 经 pluginRequirePermission 落 audit）", () => {
    // 权限闸方法锚定其专属权限：缺权即记 plugin.permission/blocked。
    expect(sandboxBridgeAuditPermission("netFetch")).toBe("net:connect");
    expect(sandboxBridgeAuditPermission("aiComplete")).toBe("ai:tools");
    expect(sandboxBridgeAuditPermission("selection.get")).toBe("ui:selection");
    // 白名单外无专属权限，锚定 ui:selection（结构拒绝恒在）。
    expect(sandboxBridgeAuditPermission("eval")).toBe("ui:selection");
    expect(sandboxBridgeAuditPermission(undefined)).toBe("ui:selection");
    // 有拒绝文案的方法必有审计锚点：deny 路径不断审计链。
    const none = new Set<string>();
    for (const method of ["selection.get", "netFetch", "aiComplete", "eval", undefined]) {
      if (sandboxBridgeDenyReason(method, none) !== null) {
        expect(sandboxBridgeAuditPermission(method)).toMatch(/:/);
      }
    }
  });
});
