import { describe, expect, it } from "vitest";
import { extractCommandOutput, isEchoOnlyTerminalOutput } from "./terminalOutputText";
import { mergeCapturedBlockCommand } from "./terminalCommandEcho";

describe("mergeCapturedBlockCommand", () => {
  it("保留较长的预注册复合命令", () => {
    const existing = "cd 'C:\\Users\\chaoj\\华为云盘'; if ($?) { ls }";
    const read = "cd 'C:\\Users\\chaoj\\华为云盘'";
    expect(mergeCapturedBlockCommand(existing, read)).toBe(existing);
  });

  it("折行残片不覆盖完整命令", () => {
    const existing = "cd 'C:\\Users\\chaoj\\华为云盘'; if ($?) { ls }";
    expect(mergeCapturedBlockCommand(existing, "{ ls }")).toBe(existing);
  });
});

describe("extractCommandOutput compound auto-ls", () => {
  it("剥离含中文路径的 cd 自动列表回显", () => {
    const display = "cd 'C:\\Users\\chaoj\\华为云盘'";
    const raw = [
      `${display}; if ($?) { ls }`,
      "",
      "    目录: C:\\Users\\chaoj\\华为云盘",
      "",
      "Mode                 LastWriteTime         Length Name",
      "----                 -------------         ------ ----",
      "d-----        2025/1/1     12:00                docs",
      "PS C:\\Users\\chaoj\\华为云盘>",
    ].join("\r\n");

    const cleaned = extractCommandOutput(raw, display);
    expect(cleaned).toContain("docs");
    expect(cleaned).not.toContain("if ($?)");
    expect(cleaned).not.toContain("cd 'C:\\Users\\chaoj\\华为云盘'");
  });

  it("单行命令回显整行丢弃", () => {
    const display = "cd 'C:\\Users\\chaoj\\华为云盘'";
    const raw = `${display}; if ($?) { ls } PS C:\\Users\\chaoj\\华为云盘>`;
    expect(extractCommandOutput(raw, display)).toBe("");
  });

  it("空目录 cd+ls 仅回显与 PS 提示符视为无输出", () => {
    const cmd = "cd 'C:\\baidunetdiskdownload'; if ($?) { ls }";
    const raw = `${cmd}\r\nPS C:\\baidunetdiskdownload>`;
    expect(extractCommandOutput(raw, cmd)).toBe("");
    expect(isEchoOnlyTerminalOutput(raw, cmd)).toBe(true);
  });

  it("空目录仅列表头时剥离为无输出", () => {
    const cmd = "cd 'C:\\baidunetdiskdownload'; if ($?) { ls }";
    const raw = [
      cmd,
      "",
      "    目录: C:\\baidunetdiskdownload",
      "",
      "PS C:\\baidunetdiskdownload>",
    ].join("\r\n");
    expect(extractCommandOutput(raw, cmd)).toBe("");
  });
});
