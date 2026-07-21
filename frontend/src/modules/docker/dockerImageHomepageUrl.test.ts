import { describe, expect, it } from "vitest";
import {
  buildDockerImageHomepageUrl,
  imageRepoPath,
  mirrorToHomepageOrigin,
} from "./dockerImageHomepageUrl";

describe("mirrorToHomepageOrigin", () => {
  it("maps 1ms registry host to web origin", () => {
    expect(mirrorToHomepageOrigin("https://docker.1ms.run")).toBe("https://1ms.run");
    expect(mirrorToHomepageOrigin("https://docker.1ms.run/")).toBe("https://1ms.run");
  });

  it("keeps unknown mirror origin", () => {
    expect(mirrorToHomepageOrigin("https://docker.m.daocloud.io")).toBe(
      "https://docker.m.daocloud.io",
    );
  });
});

describe("imageRepoPath", () => {
  it("prefixes library for official short names", () => {
    expect(imageRepoPath("nginx", true)).toBe("library/nginx");
    expect(imageRepoPath("bitnami/redis", false)).toBe("bitnami/redis");
  });
});

describe("buildDockerImageHomepageUrl", () => {
  it("builds 1ms homepage from search hit mirror", () => {
    expect(
      buildDockerImageHomepageUrl("https://docker.1ms.run", "bitnami/redis", false),
    ).toBe("https://1ms.run/r/bitnami/redis");
    expect(buildDockerImageHomepageUrl("https://docker.1ms.run", "nginx", true)).toBe(
      "https://1ms.run/r/library/nginx",
    );
  });

  it("falls back to Docker Hub when no mirror", () => {
    expect(buildDockerImageHomepageUrl(null, "nginx", true)).toBe("https://hub.docker.com/_/nginx");
    expect(buildDockerImageHomepageUrl(null, "bitnami/redis", false)).toBe(
      "https://hub.docker.com/r/bitnami/redis",
    );
  });
});
