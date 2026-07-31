import { describe, expect, it } from "vitest";
import { isServerPanelCacheStale, SERVER_PANEL_CACHE_STALE_MS } from "./serverPanelCache";

describe("isServerPanelCacheStale", () => {
  it("无缓存视为过期", () => {
    expect(isServerPanelCacheStale(null)).toBe(true);
    expect(isServerPanelCacheStale(undefined)).toBe(true);
  });

  it("未超过阈值时不过期", () => {
    const now = 1_000_000;
    expect(isServerPanelCacheStale(now - SERVER_PANEL_CACHE_STALE_MS + 1, now)).toBe(false);
  });

  it("达到或超过阈值时过期", () => {
    const now = 1_000_000;
    expect(isServerPanelCacheStale(now - SERVER_PANEL_CACHE_STALE_MS, now)).toBe(true);
    expect(isServerPanelCacheStale(now - SERVER_PANEL_CACHE_STALE_MS - 1, now)).toBe(true);
  });
});
