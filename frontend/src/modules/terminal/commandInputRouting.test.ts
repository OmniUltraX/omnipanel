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
});

describe("looksLikeEnglishQuestionInput", () => {
  it("单 token 不进", () => {
    expect(looksLikeEnglishQuestionInput("help")).toBe(false);
  });

  it("shell 动词开头不进", () => {
    expect(looksLikeEnglishQuestionInput("find my files")).toBe(false);
  });
});
