import { describe, expect, it } from "vitest";
import {
  isCdOnlyCommand,
  isCdNavigationCommand,
  normalizeAutoLsCommand,
  buildCdWithAutoLs,
  stripAutoLsSuffix,
} from "./terminalAutoLsPolicy";
import { adaptAutoLsCommandForShell } from "./terminalAutoLsShell";

describe("terminalAutoLs", () => {
  it("识别单独 cd 命令", () => {
    expect(isCdOnlyCommand("cd /tmp")).toBe(true);
    expect(isCdOnlyCommand("cd '/root/foo bar'")).toBe(true);
    expect(isCdOnlyCommand("cd ..")).toBe(true);
    expect(isCdOnlyCommand("cd /tmp && ls")).toBe(false);
    expect(isCdOnlyCommand("cd /tmp; ls")).toBe(false);
    expect(isCdOnlyCommand("ls")).toBe(false);
  });

  it("归一化自动 ls 命令", () => {
    expect(normalizeAutoLsCommand("")).toBe("ls");
    expect(normalizeAutoLsCommand("ls -a")).toBe("ls -a");
    expect(normalizeAutoLsCommand("ll -h")).toBe("ll -h");
    expect(normalizeAutoLsCommand("rm -rf /")).toBe("ls");
  });

  it("展示时去掉自动拼接后缀", () => {
    expect(stripAutoLsSuffix("cd / && ls -a")).toBe("cd /");
    expect(stripAutoLsSuffix("cd ~; if ($?) { Get-ChildItem -Force }")).toBe("cd ~");
    expect(stripAutoLsSuffix("ls -a")).toBe("ls -a");
  });

  it("POSIX 拼接 cd 与 ls", () => {
    expect(buildCdWithAutoLs("cd /", "ls", "posix")).toBe("cd / && ls");
    expect(buildCdWithAutoLs("cd /", "ls -a", "posix")).toBe("cd / && ls -a");
  });

  it("复合 cd+ls 识别为 cd 导航", () => {
    expect(isCdNavigationCommand("cd 'C:\\华为云盘'; if ($?) { ls }")).toBe(true);
    expect(isCdNavigationCommand("ls")).toBe(false);
  });

  it("PowerShell 使用 ; if ($?) { }", () => {
    expect(buildCdWithAutoLs("cd ~", "ls", "powershell")).toBe("cd ~; if ($?) { ls }");
    expect(buildCdWithAutoLs("cd ~", "ls -a", "powershell")).toBe(
      "cd ~; if ($?) { Get-ChildItem -Force }",
    );
  });

  it("cmd 将 ls 映射为 dir", () => {
    expect(adaptAutoLsCommandForShell("ls", "cmd")).toBe("dir");
    expect(buildCdWithAutoLs("cd C:\\", "ls", "cmd")).toBe("cd C:\\ && dir");
  });
});
