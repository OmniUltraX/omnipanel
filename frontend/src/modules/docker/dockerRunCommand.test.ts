import { describe, expect, it } from "vitest";
import {
  ensureDockerRunPullNever,
  extractDockerRunImage,
  tokenizeDockerCommand,
} from "./dockerRunCommand";

describe("extractDockerRunImage", () => {
  it("parses redis example", () => {
    expect(
      extractDockerRunImage(
        "docker run --name some-redis -d redis redis-server --save 60 1 --loglevel warning",
      ),
    ).toBe("redis");
  });

  it("parses namespaced image with tag", () => {
    expect(
      extractDockerRunImage("docker run -d --name demo bitnami/redis:7.2 redis-server"),
    ).toBe("bitnami/redis:7.2");
  });

  it("handles -e value options", () => {
    expect(extractDockerRunImage("docker run -e FOO=bar -p 6379:6379 -d redis:alpine")).toBe(
      "redis:alpine",
    );
  });
});

describe("ensureDockerRunPullNever", () => {
  it("injects --pull=never after run", () => {
    expect(ensureDockerRunPullNever("docker run -d redis")).toBe("docker run --pull=never -d redis");
  });

  it("overrides existing --pull", () => {
    expect(ensureDockerRunPullNever("docker run --pull=always -d redis")).toBe(
      "docker run --pull=never -d redis",
    );
  });
});

describe("tokenizeDockerCommand", () => {
  it("keeps quoted args", () => {
    expect(tokenizeDockerCommand(`docker run -e "A=b c" nginx`)).toEqual([
      "docker",
      "run",
      "-e",
      "A=b c",
      "nginx",
    ]);
  });
});
