import { describe, expect, it } from "vitest";
import { formatJvmBytes, formatThreadCount, niceAxisMax } from "./format";
import { springBootAdminChartLayout } from "./layout";

describe("formatJvmBytes", () => {
  it("formats MB and GB like Spring Boot Admin", () => {
    expect(formatJvmBytes(272629760)).toBe("260 MB");
    expect(formatJvmBytes(1426063360)).toBe("1.33 GB");
    expect(formatJvmBytes(0)).toBe("0");
    expect(formatJvmBytes(null)).toBe("—");
    expect(formatJvmBytes(-1)).toBe("—");
  });
});

describe("formatThreadCount", () => {
  it("rounds live thread counts", () => {
    expect(formatThreadCount(137.4)).toBe("137");
    expect(formatThreadCount(null)).toBe("—");
  });
});

describe("niceAxisMax", () => {
  it("ceils to a 1×10^n scale", () => {
    expect(niceAxisMax([250_000_000, 537_000_000])).toBe(600_000_000);
    expect(niceAxisMax([], 537_000_000)).toBe(600_000_000);
  });
});

describe("springBootAdminChartLayout", () => {
  it("uses a row of three charts for 4x7", () => {
    expect(springBootAdminChartLayout("4x7")).toBe("row");
    expect(springBootAdminChartLayout("4x6")).toBe("row");
    expect(springBootAdminChartLayout("6x4")).toBe("col");
    expect(springBootAdminChartLayout(undefined)).toBe("col");
  });
});
