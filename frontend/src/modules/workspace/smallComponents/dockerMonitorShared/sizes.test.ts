import { describe, expect, it } from "vitest";
import {
  composeMonitorColumnCount,
  migrateComposeMonitorSizeId,
} from "./sizes";

describe("migrateComposeMonitorSizeId", () => {
  it("maps legacy 3x3 to 4x4", () => {
    expect(migrateComposeMonitorSizeId("3x3")).toBe("4x4");
  });

  it("keeps 2x2 and 4x4", () => {
    expect(migrateComposeMonitorSizeId("2x2")).toBe("2x2");
    expect(migrateComposeMonitorSizeId("4x4")).toBe("4x4");
  });
});

describe("composeMonitorColumnCount", () => {
  it("uses one column for 2x2 and two columns for 4x4", () => {
    expect(composeMonitorColumnCount("2x2")).toBe(1);
    expect(composeMonitorColumnCount("4x4")).toBe(2);
    expect(composeMonitorColumnCount("3x3")).toBe(2);
    expect(composeMonitorColumnCount(undefined)).toBe(1);
  });
});
