import { describe, expect, it } from "vitest";
import { upsertImportCandidates } from "./importCandidates";

describe("upsertImportCandidates", () => {
  it("matches the pluginId/accountId/remoteId triple", () => {
    const a = {
      pluginId: "omni.cloud.aliyun",
      accountId: "acc-1",
      remoteId: "i-123",
      remoteKind: "ecs",
      name: "old",
    };
    const merged = upsertImportCandidates([a], [{ ...a, name: "new" }]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.name).toBe("new");
    const withOther = upsertImportCandidates(merged, [{ ...a, remoteId: "i-456", name: "other" }]);
    expect(withOther).toHaveLength(2);
  });
});
