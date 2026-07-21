import { describe, expect, it } from "vitest";
import {
  filterAndRankPathEntries,
  isPathCompletionInput,
  resolveCompletionListingDirectory,
  resolvePathCompletionPolicy,
  resolvePathCompletionTarget,
  type PathListEntry,
} from "./pathProvider";
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

function ctx(
  input: string,
  cursor = input.length,
  cwd = "/root",
): TerminalCompletionContext {
  return {
    sessionId: "sess-1",
    cwd,
    input,
    cursor,
    resourceId: "ssh-1",
    sessionType: "remote",
  };
}

const SAMPLE: PathListEntry[] = [
  { name: "cloudcanal_home", isDir: true },
  { name: "apps", isDir: true },
  { name: "warpgate", isDir: true },
  { name: "cloudcanal_x86_v4.9.0.0_docker.7z", isDir: false },
  { name: "containerd", isDir: true },
  { name: "readme.md", isDir: false },
  { name: ".hidden", isDir: true },
  { name: ".env", isDir: false },
];

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

describe("resolvePathCompletionPolicy", () => {
  it("cd/rmdir 仅目录", () => {
    expect(resolvePathCompletionPolicy(ctx("cd "))).toEqual({ accept: "dirs", prefer: "dirs" });
    expect(resolvePathCompletionPolicy(ctx("rmdir a"))).toEqual({
      accept: "dirs",
      prefer: "dirs",
    });
  });

  it("ls 目录优先，vim 文件优先", () => {
    expect(resolvePathCompletionPolicy(ctx("ls ")).prefer).toBe("dirs");
    expect(resolvePathCompletionPolicy(ctx("vim ")).prefer).toBe("files");
  });

  it("cp 无软偏好", () => {
    expect(resolvePathCompletionPolicy(ctx("cp "))).toEqual({
      accept: "all",
      prefer: "none",
    });
  });
});

describe("filterAndRankPathEntries", () => {
  it("cd 策略只保留目录，且前缀匹配优先", () => {
    const ranked = filterAndRankPathEntries(SAMPLE, "a", {
      accept: "dirs",
      prefer: "dirs",
    });
    expect(ranked.every((e) => e.isDir)).toBe(true);
    expect(ranked[0]?.name).toBe("apps");
    expect(ranked.map((e) => e.name)).not.toContain("cloudcanal_x86_v4.9.0.0_docker.7z");
    expect(ranked.map((e) => e.name)).not.toContain("readme.md");
  });

  it("vim 策略保留文件，同分时文件优先", () => {
    const ranked = filterAndRankPathEntries(
      [
        { name: "app", isDir: true },
        { name: "app.txt", isDir: false },
      ],
      "app",
      { accept: "all", prefer: "files" },
    );
    expect(ranked.map((e) => e.name)).toEqual(["app.txt", "app"]);
  });

  it("默认隐藏点文件，前缀为 . 时显示", () => {
    const hidden = filterAndRankPathEntries(SAMPLE, "", {
      accept: "all",
      prefer: "none",
    });
    expect(hidden.every((e) => !e.name.startsWith("."))).toBe(true);

    const shown = filterAndRankPathEntries(SAMPLE, ".", {
      accept: "all",
      prefer: "none",
    });
    expect(shown.some((e) => e.name === ".hidden")).toBe(true);
    expect(shown.some((e) => e.name === ".env")).toBe(true);
  });
});

describe("isPathCompletionInput / resolvePathCompletionTarget", () => {
  it("vim/cd/ls 视为路径补全场景", () => {
    expect(isPathCompletionInput(ctx("vim"))).toBe(true);
    expect(isPathCompletionInput(ctx("cd "))).toBe(true);
    expect(isPathCompletionInput(ctx("ls fo"))).toBe(true);
    expect(isPathCompletionInput(ctx("git"))).toBe(false);
  });

  it("flag 参数不触发路径补全", () => {
    expect(isPathCompletionInput(ctx("ls -l"))).toBe(false);
    expect(isPathCompletionInput(ctx("rm -rf"))).toBe(false);
  });

  it("光标停在路径命令上时，补全下一参数而不是用命令名过滤", () => {
    const target = resolvePathCompletionTarget(ctx("vim"));
    expect(target).toEqual({
      partial: "",
      replacement: { start: 3, end: 3 },
      leadSpace: true,
    });
  });

  it("已有空格参数位时，正常按路径前缀补全", () => {
    const target = resolvePathCompletionTarget(ctx("cd "));
    expect(target).toEqual({
      partial: "",
      replacement: { start: 3, end: 3 },
      leadSpace: false,
    });
  });

  it("参数前缀保留", () => {
    const target = resolvePathCompletionTarget(ctx("ls gi"));
    expect(target).toEqual({
      partial: "gi",
      replacement: { start: 3, end: 5 },
      leadSpace: false,
    });
  });
});
