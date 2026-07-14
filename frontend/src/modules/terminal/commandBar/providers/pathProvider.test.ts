import { describe, expect, it } from "vitest";
import { resolveCompletionListingDirectory } from "./pathProvider";
import type { TerminalCompletionContext } from "../types";

function remoteCtx(cwd: string): TerminalCompletionContext {
  return {
    sessionId: "sess-1",
    cwd,
    input: "ls gi",
    cursor: 5,
    resourceId: "ssh-1",
    sessionType: "remote",
  };
}

describe("resolveCompletionListingDirectory", () => {
  it("将远程 cwd 规范为 SFTP 绝对路径", () => {
    const { dir, prefix } = resolveCompletionListingDirectory(remoteCtx("/root/docker"), "gi");
    expect(dir).toBe("/root/docker");
    expect(prefix).toBe("gi");
  });

  it("file:// 前缀 cwd 可转为绝对路径", () => {
    const { dir } = resolveCompletionListingDirectory(
      remoteCtx("file:///root/docker"),
      "gi",
    );
    expect(dir).toBe("/root/docker");
  });

  it("~ 展开为 root 主目录", () => {
    const { dir } = resolveCompletionListingDirectory(remoteCtx("~"), "gi");
    expect(dir).toBe("/root");
  });
});
