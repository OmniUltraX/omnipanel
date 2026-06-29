import { describe, expect, it } from "vitest";
import { resolveCdDestination, extractTrailingShellPromptCwd, resolveShellOutputCwd } from "./resolveLsListingDirectory";

describe("resolveCdDestination", () => {
  it("解析绝对与相对 cd 目标", () => {
    expect(resolveCdDestination("cd /patch", "/", "root")).toBe("/patch");
    expect(resolveCdDestination("cd '/home'", "/patch", "root")).toBe("/home");
    expect(resolveCdDestination("cd ..", "/patch/sub", "root")).toBe("/patch");
    expect(resolveCdDestination("cd ~", "/patch", "root")).toBe("/root");
    expect(resolveCdDestination("cd /", "/patch", "root")).toBe("/");
  });

  it("Windows cd / 或 cd \\ 解析为当前盘符根目录", () => {
    expect(resolveCdDestination("cd /", "C:\\Users\\chaoj", null)).toBe("C:\\");
    expect(resolveCdDestination("cd \\", "C:\\Users\\chaoj", null)).toBe("C:\\");
  });

  it("从 PS 提示符解析 cwd", () => {
    expect(extractTrailingShellPromptCwd("PS C:\\Users\\chaoj>")).toBe("C:\\Users\\chaoj");
    expect(extractTrailingShellPromptCwd("line\r\nPS C:\\AppGallery> ")).toBe("C:\\AppGallery");
  });

  it("剥离列表表头粘连的畸形路径", () => {
    const contaminated = "    目录: C:\\Users\\chaoj\rMode                 LastWriteTime         Length Name";
    expect(resolveShellOutputCwd(contaminated)).toBe("C:\\Users\\chaoj");
    expect(
      resolveShellOutputCwd(
        "    目录: C:\\Users\\chaojMode                 LastWriteTime         Length Name",
      ),
    ).toBe("C:\\Users\\chaoj");
  });
});
