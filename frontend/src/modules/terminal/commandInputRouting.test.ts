import { describe, expect, it } from "vitest";
import {
  buildPostShellAiQuery,
  hasShellErrorSignals,
  looksLikeNaturalLanguageCommand,
  shouldRouteInputToAi,
  shouldTriggerAiAfterShell,
} from "./commandInputRouting";
import type { TerminalBlock } from "../../stores/blocksStore";

function shellBlock(overrides: Partial<TerminalBlock>): TerminalBlock {
  return {
    id: "b1",
    sessionId: "s1",
    kind: "shell",
    command: "ls",
    output: "",
    exitCode: 0,
    startLine: 0,
    endLine: 1,
    marker: null,
    cwd: "/tmp",
    timestamp: Date.now(),
    status: "completed",
    ...overrides,
  };
}

describe("shouldRouteInputToAi", () => {
  it("首字符为汉字时走 AI", () => {
    expect(shouldRouteInputToAi("帮我看一下磁盘")).toBe(true);
    expect(shouldRouteInputToAi("  查看日志")).toBe(true);
  });

  it("英文问句不走 shell", () => {
    expect(shouldRouteInputToAi("how to check disk usage")).toBe(true);
    expect(shouldRouteInputToAi("what is the largest folder")).toBe(true);
  });

  it("典型 shell 命令仍走 shell", () => {
    expect(shouldRouteInputToAi("git status")).toBe(false);
    expect(shouldRouteInputToAi("npm install")).toBe(false);
  });

  it("英文命令不走 AI", () => {
    expect(shouldRouteInputToAi("df -h")).toBe(false);
    expect(shouldRouteInputToAi("ls -la")).toBe(false);
  });

  it("保留 # 与 !! 前缀语义", () => {
    expect(shouldRouteInputToAi("# 中文")).toBe(false);
    expect(shouldRouteInputToAi("!!plan deploy")).toBe(false);
  });
});

describe("shouldTriggerAiAfterShell", () => {
  it("非零退出码触发 AI", () => {
    expect(
      shouldTriggerAiAfterShell(shellBlock({ command: "df -h", exitCode: 1, status: "failed" })),
    ).toBe(true);
  });

  it("command not found 触发 AI", () => {
    expect(
      shouldTriggerAiAfterShell(
        shellBlock({
          command: "how to check disk",
          output: "bash: how: command not found",
          exitCode: 127,
          status: "failed",
        }),
      ),
    ).toBe(true);
  });

  it("成功命令不触发 AI", () => {
    expect(
      shouldTriggerAiAfterShell(
        shellBlock({ command: "df -h", output: "Filesystem  Size\n/dev/sda1  1G", exitCode: 0 }),
      ),
    ).toBe(false);
  });
});

describe("looksLikeNaturalLanguageCommand", () => {
  it("识别英文自然语言", () => {
    expect(looksLikeNaturalLanguageCommand("how to check disk")).toBe(true);
  });

  it("识别典型 shell 命令", () => {
    expect(looksLikeNaturalLanguageCommand("git status")).toBe(false);
    expect(looksLikeNaturalLanguageCommand("df -h")).toBe(false);
  });
});

describe("hasShellErrorSignals", () => {
  it("识别常见错误输出", () => {
    expect(hasShellErrorSignals("bash: foo: command not found")).toBe(true);
    expect(hasShellErrorSignals('找不到命令 "how"，您的意思是：')).toBe(true);
    expect(hasShellErrorSignals("everything ok")).toBe(false);
  });
});

describe("buildPostShellAiQuery", () => {
  it("自然语言命令保留原文", () => {
    expect(buildPostShellAiQuery(shellBlock({ command: "how to check disk" }))).toBe(
      "how to check disk",
    );
  });
});
