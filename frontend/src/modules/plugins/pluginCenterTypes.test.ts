import { describe, expect, it } from "vitest";
import type { MarketItem } from "./pluginCenterTypes";
import {
  effectiveDownloads,
  formatPluginCount,
  sortMarketItems,
} from "./pluginCenterTypes";

function item(partial: Partial<MarketItem> & Pick<MarketItem, "id" | "name">): MarketItem {
  return {
    kind: "addon",
    version: "0.1.0",
    origin: "official",
    distribution: "bundled",
    installed: false,
    installedVersion: null,
    size: 0,
    artifactKind: null,
    dbxKey: null,
    description: "",
    permissions: [],
    needsUpdate: false,
    createdAt: null,
    updatedAt: null,
    downloads: null,
    localInstalls: 0,
    ...partial,
  };
}

describe("sortMarketItems", () => {
  it("sorts by name and keeps a stable fallback", () => {
    const sorted = sortMarketItems(
      [item({ id: "b", name: "Beta" }), item({ id: "a", name: "Alpha" })],
      "name",
      "asc",
    );
    expect(sorted.map((row) => row.id)).toEqual(["a", "b"]);
  });

  it("puts missing timestamps last regardless of direction", () => {
    const rows = [
      item({ id: "old", name: "Old", updatedAt: "2024-01-01T00:00:00Z" }),
      item({ id: "none", name: "None" }),
      item({ id: "new", name: "New", updatedAt: "2026-01-01T00:00:00Z" }),
    ];
    expect(sortMarketItems(rows, "updated", "desc").map((row) => row.id)).toEqual([
      "new",
      "old",
      "none",
    ]);
    expect(sortMarketItems(rows, "updated", "asc").map((row) => row.id)).toEqual([
      "old",
      "new",
      "none",
    ]);
  });

  it("uses local installs when GitHub download count is absent", () => {
    const rows = [
      item({ id: "local", name: "Local", localInstalls: 3 }),
      item({ id: "remote", name: "Remote", downloads: 10 }),
    ];
    expect(sortMarketItems(rows, "downloads", "desc").map((row) => row.id)).toEqual([
      "remote",
      "local",
    ]);
  });
});

describe("effectiveDownloads", () => {
  it("prefers GitHub asset counts over local installs", () => {
    expect(effectiveDownloads(item({ id: "a", name: "A", downloads: 8, localInstalls: 2 }))).toBe(8);
    expect(effectiveDownloads(item({ id: "b", name: "B", localInstalls: 2 }))).toBe(2);
    expect(effectiveDownloads(item({ id: "c", name: "C" }))).toBeNull();
  });
});

describe("formatPluginCount", () => {
  it("compacts large numbers", () => {
    expect(formatPluginCount(12)).toBe("12");
    expect(formatPluginCount(1500)).toBe("1.5k");
    expect(formatPluginCount(12_000)).toBe("12k");
  });
});
