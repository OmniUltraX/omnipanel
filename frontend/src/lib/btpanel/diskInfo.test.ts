import { describe, expect, it } from "vitest";
import { parseBtDiskUsage, parseBtDiskUsageList, parseBtHumanSizeToBytes } from "./diskInfo";

describe("parseBtHumanSizeToBytes", () => {
  it("parses official human sizes", () => {
    expect(parseBtHumanSizeToBytes("19.5 GB")).toBe(Math.round(19.5 * 1024 ** 3));
    expect(parseBtHumanSizeToBytes("4.8 GB")).toBe(Math.round(4.8 * 1024 ** 3));
    expect(parseBtHumanSizeToBytes("859.4 MB")).toBe(Math.round(859.4 * 1024 ** 2));
    expect(parseBtHumanSizeToBytes("4.8G")).toBe(Math.round(4.8 * 1024 ** 3));
  });
});

describe("parseBtDiskUsage", () => {
  it("prefers byte_size with official [total, used, free] order", () => {
    const parsed = parseBtDiskUsage({
      path: "/",
      size: ["19.5 GB", "4.8 GB", "13.8 GB", "26.00%"],
      byte_size: [20922114048, 5204590592, 14816325632],
    });
    expect(parsed).toEqual({
      path: "/",
      total: 20922114048,
      used: 5204590592,
      free: 14816325632,
      usedPercent: expect.closeTo((5204590592 / 20922114048) * 100, 5),
      fileSystem: undefined,
    });
  });

  it("falls back to size human strings without swapping used/total", () => {
    const parsed = parseBtDiskUsage({
      path: "/www",
      size: ["100G", "40G", "60G", "40%"],
      filesystem: "/dev/sdb1",
    });
    expect(parsed?.path).toBe("/www");
    expect(parsed?.total).toBe(Math.round(100 * 1024 ** 3));
    expect(parsed?.used).toBe(Math.round(40 * 1024 ** 3));
    expect(parsed?.free).toBe(Math.round(60 * 1024 ** 3));
    expect(parsed?.usedPercent).toBe(40);
    expect(parsed?.fileSystem).toBe("/dev/sdb1");
  });

  it("does not treat size[0] as used (legacy bug)", () => {
    const parsed = parseBtDiskUsage({
      path: "/",
      size: ["19.5 GB", "4.8 GB", "13.8 GB", "26.00%"],
    });
    // 若误把 size[0] 当 used，used 会接近 total
    expect(parsed!.used).toBeLessThan(parsed!.total);
    expect(parsed!.used).toBe(Math.round(4.8 * 1024 ** 3));
  });
});

describe("parseBtDiskUsageList", () => {
  it("maps all partitions", () => {
    const list = parseBtDiskUsageList([
      { path: "/", byte_size: [100, 40, 60] },
      { path: "/www", byte_size: [200, 50, 150] },
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]?.path).toBe("/");
    expect(list[1]?.total).toBe(200);
  });
});
