import { describe, expect, it } from "vitest";

import {
  clampRemotePathToRoot,
  effectiveRemoteBrowsePath,
  normalizeRemotePosixPath,
  remoteConnectionRootPath,
} from "./fileNavigationPath";

describe("SFTP/FTP browse path vs connection root", () => {
  it("empty current path falls back to the real rootPath, not /", () => {
    const root = remoteConnectionRootPath("sftp", "/home/gui-test");
    expect(root).toBe("/home/gui-test");
    expect(effectiveRemoteBrowsePath("", root)).toBe("/home/gui-test");
    expect(effectiveRemoteBrowsePath(undefined, root)).toBe("/home/gui-test");
  });

  it("keeps an explicit current path under the root", () => {
    const root = remoteConnectionRootPath("sftp", "/home/gui-test");
    expect(effectiveRemoteBrowsePath("/home/gui-test/docs", root)).toBe(
      "/home/gui-test/docs",
    );
  });

  it("clamps navigation above the connection root", () => {
    const root = "/home/gui-test";
    expect(clampRemotePathToRoot("/", root)).toBe("/home/gui-test");
    expect(clampRemotePathToRoot("/home", root)).toBe("/home/gui-test");
    expect(clampRemotePathToRoot("/home/gui-test", root)).toBe("/home/gui-test");
    expect(clampRemotePathToRoot("/home/gui-test/a", root)).toBe("/home/gui-test/a");
    expect(clampRemotePathToRoot("/home/gui-test-other", root)).toBe("/home/gui-test");
  });

  it("normalizes trailing slashes and is a no-op for local/s3 roots", () => {
    expect(normalizeRemotePosixPath("/home/gui-test/")).toBe("/home/gui-test");
    expect(remoteConnectionRootPath("local", "/home/gui-test")).toBe("");
    expect(remoteConnectionRootPath("s3", "bucket")).toBe("");
  });
});
