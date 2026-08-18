import { describe, expect, it } from "vitest";
import { resolveCommandProfile } from "./terminalCommandProfile";
import {
  isEchoOnlyTerminalOutput,
  isLikelyCommandEchoAsOutput,
  looksLikePowerShellProgressText,
  watchHasTrailingPowerShellPrompt,
} from "./terminalOutputText";

const LONG_CMD =
  "$cpu = Get-CimInstance Win32_Processor; $os = Get-CimInstance Win32_OperatingSystem";
const SHORT_CMD =
  "Get-CimInstance Win32_Processor | Select-Object -ExpandProperty Name";

describe("半截命令回显", () => {
  it("截断到命令前缀仍视为回显，不是结果", () => {
    expect(isEchoOnlyTerminalOutput("$cpu = Get-CimIn", LONG_CMD)).toBe(true);
    expect(isLikelyCommandEchoAsOutput("$cpu = Get-CimIn", LONG_CMD)).toBe(true);
    expect(isEchoOnlyTerminalOutput("Get-CimInstance W", SHORT_CMD)).toBe(true);
    expect(isLikelyCommandEchoAsOutput("Get-CimInstance W", SHORT_CMD)).toBe(true);
  });

  it("真实结果不是命令前缀", () => {
    expect(isEchoOnlyTerminalOutput("Intel(R) Core(TM) i7", LONG_CMD)).toBe(false);
    expect(isLikelyCommandEchoAsOutput("Intel(R) Core(TM) i7", LONG_CMD)).toBe(false);
  });

  it("command not found 不是短命令回显", () => {
    expect(
      isLikelyCommandEchoAsOutput("date现在的时间: command not found", "date"),
    ).toBe(false);
  });
});

describe("PowerShell 进度条与提示符", () => {
  it("识别 Get-ComputerInfo 进度文案", () => {
    expect(looksLikePowerShellProgressText("正在加载计算机信息")).toBe(true);
    expect(looksLikePowerShellProgressText("Loading computer information")).toBe(true);
    expect(looksLikePowerShellProgressText("Name  NumberOfCores")).toBe(false);
  });

  it("末尾 PS> 才算命令结束", () => {
    expect(
      watchHasTrailingPowerShellPrompt("AMD Ryzen 7\r\nPS C:\\Users\\chaoj>"),
    ).toBe(true);
    expect(
      watchHasTrailingPowerShellPrompt(
        "2024年8月14日 23:41:56PS C:\\Users\\chaoj>",
      ),
    ).toBe(true);
    expect(watchHasTrailingPowerShellPrompt("PS C:\\Users\\chaoj>")).toBe(false);
    expect(watchHasTrailingPowerShellPrompt("正在加载计算机信息")).toBe(false);
    expect(watchHasTrailingPowerShellPrompt("Name  NumberOfCores")).toBe(false);
  });

  it("含 Get-ComputerInfo 的命令走 progress 配置", () => {
    const profile = resolveCommandProfile(
      "Get-CimInstance Win32_Processor; Get-ComputerInfo | Select-Object OsName",
      "AI",
    );
    expect(profile.kind).toBe("progress");
    expect(profile.outputIdleMs).toBe(3_000);
  });
});
