import { describe, expect, it, vi } from "vitest";

vi.mock("./commandBar/shellHistorySync", () => ({
  isSilentHistorySyncCommand: () => false,
}));
vi.mock("./interactiveCommands", () => ({
  isInteractiveTerminalCommandFallback: () => false,
}));
vi.mock("./terminalOutputText", () => ({
  normalizeBlockCommand: (cmd: string) => cmd.trim(),
}));

import { shouldRouteInputToAi, looksLikeEnglishQuestionInput } from "./commandInputRouting";

describe("shouldRouteInputToAi", () => {
  it("中文自然语言进 AI", () => {
    expect(shouldRouteInputToAi("看看磁盘还剩多少")).toBe(true);
    expect(shouldRouteInputToAi("重启 nginx")).toBe(true);
  });

  it("CJK 路径/脚本名不进 AI", () => {
    expect(shouldRouteInputToAi("./备份.sh")).toBe(false);
    expect(shouldRouteInputToAi("脚本.py")).toBe(false);
  });

  it("已知 shell 动词不进 AI", () => {
    expect(shouldRouteInputToAi("ls -la")).toBe(false);
    expect(shouldRouteInputToAi("docker ps")).toBe(false);
    expect(shouldRouteInputToAi("git status")).toBe(false);
    expect(shouldRouteInputToAi("find . -name '*.ts'")).toBe(false);
  });

  it("英文问句进 AI", () => {
    expect(shouldRouteInputToAi("how do I list docker containers")).toBe(true);
    expect(shouldRouteInputToAi("please install nginx for me")).toBe(true);
    expect(shouldRouteInputToAi("install docker on this host")).toBe(true);
  });

  it("排除注释与 agent 前缀", () => {
    expect(shouldRouteInputToAi("# 帮我查磁盘")).toBe(false);
    expect(shouldRouteInputToAi("/agent 查日志")).toBe(false);
    expect(shouldRouteInputToAi("!!")).toBe(false);
  });

  it("交互式程序提示不进 AI", () => {
    expect(shouldRouteInputToAi("Do you want to continue? [Y/n]")).toBe(false);
    expect(shouldRouteInputToAi("Do you want to continue? [y/N]")).toBe(false);
    expect(shouldRouteInputToAi("Continue? [yes/no]")).toBe(false);
    expect(shouldRouteInputToAi("Press enter to continue")).toBe(false);
    expect(shouldRouteInputToAi("Press Q to continue")).toBe(false);
  });

  it("命令 + 中文后缀混合输入进 AI", () => {
    expect(shouldRouteInputToAi("ls -s -a 上面这个命令帮我执行一下")).toBe(true);
    expect(shouldRouteInputToAi("docker ps 看看容器")).toBe(true);
    expect(shouldRouteInputToAi("git status 帮我查一下")).toBe(true);
    expect(shouldRouteInputToAi("ls 帮我看看")).toBe(true);
  });

  it("引号内中文不误判为 NL", () => {
    expect(shouldRouteInputToAi('echo "你好"')).toBe(false);
    expect(shouldRouteInputToAi('git commit -m "修复"')).toBe(false);
    expect(shouldRouteInputToAi('printf "中文消息"')).toBe(false);
  });
});

describe("looksLikeEnglishQuestionInput", () => {
  it("单 token 不进", () => {
    expect(looksLikeEnglishQuestionInput("help")).toBe(false);
  });

  it("shell 动词开头不进", () => {
    expect(looksLikeEnglishQuestionInput("find my files")).toBe(false);
  });
});
