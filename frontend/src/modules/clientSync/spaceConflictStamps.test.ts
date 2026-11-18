import { describe, expect, it } from "vitest";
import { isUpdateStampField, stampOnlyDecision } from "./spaceConflictStamps";

describe("stampOnlyDecision", () => {
  it("只有 updatedAt 不同时采用较新的一边", () => {
    const cloud = JSON.stringify({ name: "default", updatedAt: 1794884856297 });
    const local = JSON.stringify({ name: "default", updatedAt: 1794795976763 });
    expect(stampOnlyDecision(cloud, local)).toBe("current");
    expect(stampOnlyDecision(local, cloud)).toBe("saved");
  });

  it("还有别的字段不同时不自动选边", () => {
    const cloud = JSON.stringify({ name: "cloud", updatedAt: 9 });
    const local = JSON.stringify({ name: "local", updatedAt: 1 });
    expect(stampOnlyDecision(cloud, local)).toBeNull();
  });

  it("createdAt 不算更新日期", () => {
    const cloud = JSON.stringify({ name: "default", createdAt: 2 });
    const local = JSON.stringify({ name: "default", createdAt: 1 });
    expect(stampOnlyDecision(cloud, local)).toBeNull();
    expect(isUpdateStampField("createdAt")).toBe(false);
    expect(isUpdateStampField("updated_at")).toBe(true);
  });
});
