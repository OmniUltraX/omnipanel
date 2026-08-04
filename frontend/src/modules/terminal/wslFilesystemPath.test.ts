import { describe, expect, it } from "vitest";
import {
  resolveLocalFilesPanelPath,
  resolveWslDistroName,
  wslLinuxPathToWindowsPath,
} from "./wslFilesystemPath";

describe("wslFilesystemPath", () => {
  it("映射 Linux 家目录到 \\\\wsl$ UNC", () => {
    expect(wslLinuxPathToWindowsPath("Ubuntu", "/home/chaoj")).toBe(
      "\\\\wsl$\\Ubuntu\\home\\chaoj",
    );
    expect(wslLinuxPathToWindowsPath("Ubuntu", "/")).toBe("\\\\wsl$\\Ubuntu");
  });

  it("映射 /mnt/c 到盘符路径", () => {
    expect(wslLinuxPathToWindowsPath("Ubuntu", "/mnt/c/Users/chaoj")).toBe(
      "C:\\Users\\chaoj",
    );
  });

  it("从 shellLabel 解析发行版", () => {
    expect(resolveWslDistroName({ shellLabel: "Ubuntu (WSL)", shellSpec: null })).toBe(
      "Ubuntu",
    );
  });

  it("resolveLocalFilesPanelPath 对 WSL 会话生效", () => {
    const path = resolveLocalFilesPanelPath({
      type: "local",
      cwd: "/home/chaoj",
      shellLabel: "Ubuntu (WSL)",
      shellSpec: { kind: "wsl", path: null, wslDistro: "Ubuntu" },
    });
    expect(path).toBe("\\\\wsl$\\Ubuntu\\home\\chaoj");
  });

  it("WSL 会话忽略残留的 Windows 盘符 cwd", () => {
    const path = resolveLocalFilesPanelPath({
      type: "local",
      cwd: "C:/Users/chaoj",
      shellLabel: "Ubuntu (WSL)",
      shellSpec: { kind: "wsl", path: null, wslDistro: "Ubuntu" },
    });
    expect(path).toBe("\\\\wsl$\\Ubuntu\\home");
  });
});
