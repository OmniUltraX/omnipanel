import { describe, expect, it } from "vitest";
import {
  SSH_EXEC_TOOL_NAME,
  TERMINAL_EXEC_TOOL_NAME,
  argsHaveResourceId,
  isTerminalPtyExecTool,
  normalizeTerminalPtyExecToolName,
  parseTerminalExecCommand,
} from "./terminalExecTool";

describe("terminalExecTool", () => {
  it("识别当前 Tab PTY 工具与历史别名", () => {
    expect(isTerminalPtyExecTool(TERMINAL_EXEC_TOOL_NAME)).toBe(true);
    expect(isTerminalPtyExecTool("omni_terminal_run_terminal_command")).toBe(true);
    expect(isTerminalPtyExecTool("run_terminal_command")).toBe(true);
    expect(isTerminalPtyExecTool(SSH_EXEC_TOOL_NAME)).toBe(false);
  });

  it("别名规范化为 omni_terminal_exec", () => {
    expect(normalizeTerminalPtyExecToolName("run_terminal_command")).toBe(
      TERMINAL_EXEC_TOOL_NAME,
    );
    expect(normalizeTerminalPtyExecToolName(SSH_EXEC_TOOL_NAME)).toBe(SSH_EXEC_TOOL_NAME);
  });

  it("解析 command / cmd", () => {
    expect(parseTerminalExecCommand('{"command":"Get-Date"}')).toBe("Get-Date");
    expect(parseTerminalExecCommand('{"cmd":"date"}')).toBe("date");
    expect(parseTerminalExecCommand("{}")).toBe("");
  });

  it("判断是否带 resource_id", () => {
    expect(argsHaveResourceId('{"command":"date"}')).toBe(false);
    expect(argsHaveResourceId('{"resource_id":"ssh-1","command":"uptime"}')).toBe(true);
  });
});
