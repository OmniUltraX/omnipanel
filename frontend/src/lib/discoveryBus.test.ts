import { describe, expect, it } from "vitest";
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
    expect(isDiscoverySkip({ added: 1 })).toBe(false);
  });
});
