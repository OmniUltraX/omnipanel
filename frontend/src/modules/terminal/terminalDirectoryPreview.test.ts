import { describe, expect, it } from "vitest";
import type { TerminalBlock } from "../../stores/blocksStore";
import { shouldUseDirectoryPreview } from "./terminalDirectoryPreview";

function shellBlock(overrides: Partial<TerminalBlock>): TerminalBlock {
  return {
    id: "b1",
    sessionId: "s1",
    kind: "shell",
    command: "",
    output: "",
    exitCode: 0,
    startLine: 0,
    endLine: -1,
    marker: null,
    cwd: "C:\\baidunetdiskdownload",
    timestamp: 0,
    status: "completed",
    ...overrides,
  };
}

describe("shouldUseDirectoryPreview", () => {
  it("空目录 cd+ls 仅显示面包屑", () => {
    const cmd = "cd 'C:\\baidunetdiskdownload'; if ($?) { ls }";
    const output = `${cmd}\r\nPS C:\\baidunetdiskdownload>`;
    expect(
      shouldUseDirectoryPreview(
        shellBlock({
          command: cmd,
          output,
        }),
      ),
    ).toBe(true);
  });

  it("收到回显后可提前进入目录预览", () => {
    const cmd = "cd 'C:\\baidunetdiskdownload'; if ($?) { ls }";
    const output = `${cmd}\r\nPS C:\\baidunetdiskdownload>`;
    expect(
      shouldUseDirectoryPreview(
        shellBlock({
          command: cmd,
          output,
          status: "running",
        }),
      ),
    ).toBe(true);
  });

  it("有文件列表时不使用目录预览", () => {
    const cmd = "cd 'C:\\persistent_data'; if ($?) { ls }";
    const output = [
      cmd,
      "",
      "    目录: C:\\persistent_data",
      "",
      "Mode                 LastWriteTime         Length Name",
      "----                 -------------         ------ ----",
      "-a----        2026/5/6      9:47             40 user_dict_clean_up.bin",
      "PS C:\\persistent_data>",
    ].join("\r\n");
    expect(
      shouldUseDirectoryPreview(
        shellBlock({
          command: cmd,
          output,
        }),
      ),
    ).toBe(false);
  });
});
