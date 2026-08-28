import { describe, expect, it } from "vitest";
import { MOCK_WARPGATE_TARGETS, targetsToCandidates, WARPGATE_PLUGIN_ID } from "./mapTargets";

describe("warpgate targetsToCandidates", () => {
  it("maps mock fixture to bastion entry rather than internal IP", () => {
    const candidates = targetsToCandidates("acc-1", MOCK_WARPGATE_TARGETS);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.pluginId).toBe(WARPGATE_PLUGIN_ID);
    expect(candidates[0]?.accountId).toBe("acc-1");
    expect(candidates[0]?.config).toMatchObject({
      host: "bastion.example.com",
      port: 2222,
      user: "root:prod-web-1",
    });
    expect((candidates[0]?.config as { password?: string }).password).toBeUndefined();
    expect(JSON.stringify(candidates[0]?.config)).not.toContain("10.0.1.12");
    expect(candidates[1]?.config).toMatchObject({
      host: "bastion.example.com",
      port: 33306,
      user: "app#app-mysql",
    });
    expect(JSON.stringify(candidates[1]?.config)).not.toContain("10.0.2.20");
  });
});
