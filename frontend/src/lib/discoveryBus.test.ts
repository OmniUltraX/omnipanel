import { describe, expect, it } from "vitest";
import { resolveProbeOwnership } from "./discoveryScope";
import { isDiscoverySkip, isProdEnvTag, sshDiscoveryScope } from "./discoveryScope";

describe("discoveryBus prod gate", () => {
  it("treats prod / prod-* / production as production", () => {
    expect(isProdEnvTag("prod")).toBe(true);
    expect(isProdEnvTag("prod-cn")).toBe(true);
    expect(isProdEnvTag("production")).toBe(true);
    expect(isProdEnvTag("unknown")).toBe(false);
    expect(isProdEnvTag("dev")).toBe(false);
  });

  it("keeps prod hosts out of the default scope until the user confirms", () => {
    const { scope, skippedProdCount, prodHostIds } = sshDiscoveryScope([
      { id: "a", kind: "ssh", envTag: "prod" },
      { id: "b", kind: "panel", envTag: "prod" },
    ]);
    expect(scope.envTag).toBeNull();
    expect(scope.hostIds).toEqual([]);
    expect(prodHostIds).toEqual(["a"]);
    expect(skippedProdCount).toBe(1);
  });

  it("drops prod hosts from mixed inventories so the probe only sees others", () => {
    const { scope, skippedProdCount, prodHostIds } = sshDiscoveryScope([
      { id: "dev1", kind: "ssh", envTag: "dev" },
      { id: "prod1", kind: "ssh", envTag: "prod" },
    ]);
    expect(scope.envTag).toBeNull();
    expect(scope.hostIds).toEqual(["dev1"]);
    expect(skippedProdCount).toBe(1);
    expect(prodHostIds).toEqual(["prod1"]);
  });

  it("recognizes skip payload", () => {
    expect(isDiscoverySkip({ skipped: true, reason: "prod" })).toBe(true);
    expect(isDiscoverySkip({ skipped: true, reason: "cancelled" })).toBe(true);
    expect(isDiscoverySkip({ skipped: true, reason: "no-owner" })).toBe(true);
    expect(isDiscoverySkip({ added: 1 })).toBe(false);
  });
});

describe("resolveProbeOwnership", () => {
  it("内核 probe 无声明时由内核拥有", () => {
    expect(resolveProbeOwnership("ssh-docker", [])).toBe("kernel");
  });

  it("有声明且有激活拥有者时放行", () => {
    expect(
      resolveProbeOwnership("ssh-panel", [
        { id: "omni.panel.1panel", activated: false, probeIds: ["ssh-panel"] },
        { id: "omni.panel.bt", activated: true, probeIds: ["ssh-panel"] },
      ]),
    ).toBe("owned");
  });

  it("有声明但无激活拥有者时跳过（禁面板插件后 ssh-panel 不空跑）", () => {
    expect(
      resolveProbeOwnership("ssh-panel", [
        { id: "omni.panel.1panel", activated: false, probeIds: ["ssh-panel"] },
        { id: "omni.panel.bt", activated: false, probeIds: ["ssh-panel"] },
      ]),
    ).toBe("no-owner");
  });

  it("无关声明不影响其它 probe", () => {
    expect(
      resolveProbeOwnership("module-http", [
        { id: "omni.panel.1panel", activated: true, probeIds: ["ssh-panel"] },
      ]),
    ).toBe("kernel");
  });
});
