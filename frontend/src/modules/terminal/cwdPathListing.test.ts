import { beforeEach, describe, expect, it } from "vitest";
import {
  getCachedPathListing,
  invalidatePathListingCache,
  pathListingCacheKey,
  setCachedPathListing,
} from "./commandBar/pathListingCache";
import { lookupCwdPathName, resolveCwdListingDir } from "./cwdPathListing";

describe("cwd path listing cache", () => {
  beforeEach(() => {
    invalidatePathListingCache();
  });

  it("缓存命中后可按名字查出 kind", () => {
    const dir = resolveCwdListingDir("remote", "/root");
    const key = pathListingCacheKey("remote", "ssh-1", dir);
    setCachedPathListing(key, [
      { name: "src", isDir: true },
      { name: "README.md", isDir: false },
    ]);
    expect(getCachedPathListing(key)?.length).toBe(2);
    expect(lookupCwdPathName("remote", "ssh-1", "/root", "src")).toEqual({
      name: "src",
      isDir: true,
    });
  });

  it("本地不同 resourceId / 斜杠写法共用同一缓存", () => {
    const dir = resolveCwdListingDir("local", "C:/Users/chaoj");
    setCachedPathListing(pathListingCacheKey("local", null, dir), [
      { name: "src", isDir: true },
      { name: "README.md", isDir: false },
    ]);
    expect(lookupCwdPathName("local", "local-terminal", "C:\\Users\\chaoj", "README.md")).toEqual({
      name: "README.md",
      isDir: false,
    });
  });
});
