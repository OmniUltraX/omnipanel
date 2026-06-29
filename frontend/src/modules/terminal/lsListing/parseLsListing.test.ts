import { describe, expect, it } from "vitest";
import { lsEntryDisplayName, normalizeLsEntryName, tryParseLsListing } from "./parseLsListing";
import { looksLikeShellCommandEcho } from "../terminalCommandEcho";

describe("tryParseLsListing", () => {
  it("解析 cd 拼接 ls 的输出", () => {
    const output = "bin  etc  home  lib  root  tmp  usr  var";
    expect(tryParseLsListing("cd / && ls", output)).not.toBeNull();
    expect(tryParseLsListing("cd / && ls -a", output)).not.toBeNull();
    expect(tryParseLsListing("cd ~; if ($?) { ls }", output)).not.toBeNull();
  });

  it("解析 plain ls 多列输出", () => {
    const output = "docker  demo.py  a.sh  anaconda3  README.zip";
    const result = tryParseLsListing("ls", output);
    expect(result).not.toBeNull();
    expect(result!.layout).toBe("grid");
    const byName = Object.fromEntries(result!.entries.map((e) => [e.name, e.kind]));
    expect(byName.docker).toBe("directory");
    expect(byName.anaconda3).toBe("directory");
    expect(byName["demo.py"]).toBe("code");
    expect(byName["a.sh"]).toBe("executable");
    expect(byName["README.zip"]).toBe("archive");
  });

  it("解析带提示符前缀的 ls 命令", () => {
    const output = "logs nacos install_panel.sh";
    expect(tryParseLsListing("[root@p3 ~]# ls", output)).not.toBeNull();
    expect(tryParseLsListing("root@3 : / $ ls", output)).not.toBeNull();
  });

  it("解析逐行输出的 ls", () => {
    const output = [
      "1panel-v2.1.13-linux-amd64",
      "install_panel.sh",
      "logs",
      "nacos",
      "pig-upms-biz.jar",
    ].join("\n");
    const result = tryParseLsListing("ls", output);
    expect(result?.entries.map((e) => e.name)).toEqual([
      "1panel-v2.1.13-linux-amd64",
      "install_panel.sh",
      "logs",
      "nacos",
      "pig-upms-biz.jar",
    ]);
  });

  it("plain ls 输出夹杂一行权限串时不应整段失败", () => {
    const output = [
      "drwxr-xr-x 2 root root 4096 Jan  1 12:00 logs",
      "install_panel.sh",
      "nacos",
    ].join("\n");
    const result = tryParseLsListing("ls", output);
    expect(result?.layout).toBe("grid");
    expect(result?.entries.map((e) => e.name)).toEqual(["install_panel.sh", "nacos"]);
  });

  it("解析 ll 长格式别名", () => {
    const output = [
      "total 512",
      "-rwxr-xr-x 1 root root 123 Mar 23 12:00 1panel-agent",
      "drwxr-xr-x 2 root root 4096 Mar 23 12:00 initscript",
      "-rwxr-xr-x 1 root root 456 Mar 23 12:00 install.sh",
    ].join("\n");
    const result = tryParseLsListing("ll", output);
    expect(result?.layout).toBe("long");
    const kinds = Object.fromEntries(result!.entries.map((e) => [e.name, e.kind]));
    expect(kinds["1panel-agent"]).toBe("executable");
    expect(kinds.initscript).toBe("directory");
    expect(kinds["install.sh"]).toBe("executable");
    expect(result!.entries[0]?.longDetail).toContain("rwxr-xr-x");
  });

  it("解析带 # 前缀的 ll 命令", () => {
    const output = "-rw-r--r-- 1 root root 1 Mar 23 12:00 a\n-rw-r--r-- 1 root root 2 Mar 23 12:00 b";
    expect(tryParseLsListing("# ll", output)?.layout).toBe("long");
  });

  it("解析 PowerShell d---- 短 Mode 列", () => {
    const output = [
      "Mode                 LastWriteTime         Length Name",
      "----                 -------------         ------ ----",
      "d----          3/29/2026   3:29 PM                Windows",
      "-a---          3/29/2026   3:29 PM             1234 appverifUI.dll",
      "d----          3/29/2026   3:29 PM                Program Files",
    ].join("\n");
    const result = tryParseLsListing("ls", output);
    expect(result?.layout).toBe("long");
    expect(result!.entries.find((e) => e.name === "Windows")?.navigable).toBe(true);
    expect(result!.entries.find((e) => e.name === "appverifUI.dll")?.kind).toBe("executable");
  });

  it("解析 PowerShell dir 长格式", () => {
    const output = [
      "Directory: C:\\Users\\chaoj",
      "",
      "Mode                 LastWriteTime         Length Name",
      "----                 -------------         ------ ----",
      "d-----         3/29/2026   3:29 PM                .agent-tars",
      "-a----         3/29/2026   3:29 PM             1234 package.json",
      "d-----         3/29/2026   3:29 PM                .cursor",
    ].join("\n");
    const result = tryParseLsListing("dir", output);
    expect(result?.layout).toBe("long");
    const names = result!.entries.map((entry) => entry.name);
    expect(names).toContain(".agent-tars");
    expect(names).toContain("package.json");
    expect(names).not.toContain("d-----");
    expect(result!.entries.find((entry) => entry.name === ".agent-tars")?.navigable).toBe(true);
    expect(result!.entries.find((entry) => entry.name === "package.json")?.navigable).toBeFalsy();
  });

  it("剥除 ls -F 目录尾部 / 避免显示双斜杠", () => {
    const output = [
      "dr-xr-x--- 72 root root 94 Jun 29 01:21 ./",
      "drwxr-xr-x 28 root root 88 Jun 26 10:48 ../",
      "drwxr-xr-x  3 root root  4 Feb 17 15:40 .ai_completion/",
    ].join("\n");
    const result = tryParseLsListing("ll -ah", output)!;
    expect(result.entries.map((e) => e.name)).toEqual([".", "..", ".ai_completion"]);
    expect(lsEntryDisplayName({ name: ".", kind: "directory" })).toBe("./");
    expect(lsEntryDisplayName({ name: ".ai_completion", kind: "directory" })).toBe(
      ".ai_completion/",
    );
    expect(normalizeLsEntryName(".android/")).toBe(".android");
  });

  it("解析 ls -l 长格式", () => {
    const output = [
      "total 8",
      "drwxr-xr-x 2 root root 4096 Jan  1 12:00 projects",
      "-rwxr-xr-x 1 root root  128 Jan  1 12:00 run.sh",
      "lrwxrwxrwx 1 root root   10 Jan  1 12:00 link -> target",
    ].join("\n");
    const result = tryParseLsListing("ls -l", output);
    expect(result?.layout).toBe("long");
    const kinds = Object.fromEntries(result!.entries.map((e) => [e.name, e.kind]));
    expect(kinds.projects).toBe("directory");
    expect(kinds["run.sh"]).toBe("executable");
    expect(kinds.link).toBe("symlink");
    expect(result!.entries.find((e) => e.name === "link")?.navigable).toBe(true);
    expect(result!.entries.find((e) => e.name === "projects")?.navigable).toBe(true);
  });

  it("不把 PowerShell 命令回显误解析为目录列表", () => {
    const echo =
      "cd 'C:\\Users\\chaoj\\华为云盘'; if ($?) { ls } PS C:\\Users\\chaoj\\华为云盘>";
    expect(looksLikeShellCommandEcho(echo)).toBe(true);
    expect(tryParseLsListing("cd 'C:\\Users\\chaoj\\华为云盘'; if ($?) { ls }", echo)).toBeNull();
  });
});
