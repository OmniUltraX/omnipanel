import { describe, expect, it } from "vitest";

import { memStatusBadge } from "./monitoringUtils";

describe("memStatusBadge", () => {
  it("does not call 0%/unknown memory 充裕", () => {
    expect(memStatusBadge(0, { known: false })).toEqual({ label: "未知", tone: "accent" });
  });

  it("still treats a real 0% used of a known total as 充裕", () => {
    expect(memStatusBadge(0, { known: true })).toEqual({ label: "充裕", tone: "success" });
    expect(memStatusBadge(0)).toEqual({ label: "充裕", tone: "success" });
  });

  it("keeps the existing pressure thresholds", () => {
    expect(memStatusBadge(70).label).toBe("注意");
    expect(memStatusBadge(90).label).toBe("紧张");
  });
});
