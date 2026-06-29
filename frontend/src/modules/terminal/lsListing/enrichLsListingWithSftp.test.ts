import { describe, expect, it } from "vitest";
import { enrichLsListingWithSftp } from "./enrichLsListingWithSftp";
import type { LsListing } from "./parseLsListing";
import { resolveLsListingDirectory, joinListingEntryPath, resolveListingDirectoryForBlock } from "./resolveLsListingDirectory";

describe("resolveLsListingDirectory", () => {
  it("ll 使用 block cwd", () => {
    expect(resolveLsListingDirectory("ll", "/root/projects", "root")).toBe("/root/projects");
  });

  it("dir 在 C: 盘使用 block cwd", () => {
    expect(resolveLsListingDirectory("dir", "C:", null)).toBe("C:\\");
    expect(resolveLsListingDirectory("ls", "C:\\", null)).toBe("C:\\");
  });

  it("无参数时使用 block cwd", () => {
    expect(resolveLsListingDirectory("ls", "/root/projects", "root")).toBe("/root/projects");
  });

  it("解析相对子目录", () => {
    expect(resolveLsListingDirectory("ls docker", "/root", "root")).toBe("/root/docker");
  });

  it("显式文件参数时列出父目录", () => {
    expect(resolveLsListingDirectory("ls Makefile", "/root", "root")).toBe("/root");
  });

  it("C: 盘根路径拼接", () => {
    expect(joinListingEntryPath("C:", "Windows")).toBe("C:\\Windows");
    expect(joinListingEntryPath("C:\\", "Windows")).toBe("C:\\Windows");
  });

  it("Windows cwd 下拼接路径", () => {
    expect(joinListingEntryPath("C:\\Users\\chaoj", ".cursor")).toBe("C:\\Users\\chaoj\\.cursor");
  });

  it("拼接列表条目绝对路径", () => {
    expect(joinListingEntryPath("/", "sbin.usr-is-merged")).toBe("/sbin.usr-is-merged");
    expect(joinListingEntryPath("/tmp", "foo")).toBe("/tmp/foo");
  });

  it("复合 cd+ls 命令使用 block cwd 而非 cd 目标", () => {
    const cwd = "C:\\Users\\chaoj";
    expect(resolveLsListingDirectory("cd ~; if ($?) { ls }", cwd, null)).toBe(cwd);
    expect(
      joinListingEntryPath(
        resolveLsListingDirectory("cd ~; if ($?) { ls }", cwd, null)!,
        "WPSDrive",
      ),
    ).toBe("C:\\Users\\chaoj\\WPSDrive");
  });

  it("Get-ChildItem -Force 仅列当前目录", () => {
    expect(resolveLsListingDirectory("Get-ChildItem -Force", "C:\\Users\\chaoj", null)).toBe(
      "C:\\Users\\chaoj",
    );
  });
});

describe("resolveListingDirectoryForBlock", () => {
  it("复合 cd+ls 从 block 起始 cwd 推断列表目录", () => {
    expect(resolveListingDirectoryForBlock("cd '/home' && ls", "/")).toBe("/home");
  });

  it("历史 block 点击条目不受后续会话 cwd 影响", () => {
    const homeBlockCwd = "/home";
    const listingDir = resolveListingDirectoryForBlock("cd '/home' && ls", homeBlockCwd);
    expect(listingDir).toBe("/home");
    expect(joinListingEntryPath(listingDir, "application")).toBe("/home/application");
    expect(joinListingEntryPath(listingDir, "ecs-assist-user")).toBe("/home/ecs-assist-user");
  });

  it("PowerShell 复合 cd+ls 使用 block cwd", () => {
    const cwd = "C:\\Users\\chaoj";
    const listingDir = resolveListingDirectoryForBlock("cd ~; if ($?) { ls }", cwd);
    expect(listingDir).toBe(cwd);
    expect(joinListingEntryPath(listingDir, "WPSDrive")).toBe("C:\\Users\\chaoj\\WPSDrive");
  });

  it("Windows 绝对路径 cd+ls 在 block cwd 仍为父目录时使用 cd 目标", () => {
    const compound = "cd 'C:\\Program Files (x86)\\PL2303'; if ($?) { ls }";
    const parentCwd = "C:\\Program Files (x86)";
    const listingDir = resolveListingDirectoryForBlock(compound, parentCwd);
    expect(listingDir).toBe("C:\\Program Files (x86)\\PL2303");
    expect(joinListingEntryPath(listingDir, "PL-2303_backup")).toBe(
      "C:\\Program Files (x86)\\PL2303\\PL-2303_backup",
    );
  });

  it("仅传 ls 子命令时无法推断 cd 目标目录", () => {
    const parentCwd = "C:\\Program Files (x86)";
    expect(resolveListingDirectoryForBlock("ls", parentCwd)).toBe(parentCwd);
  });

  it("cd 到盘符根目录时使用 C:\\ 作为列表目录", () => {
    const parentCwd = "C:\\Program Files (x86)";
    const compound = "cd 'C:'; if ($?) { ls }";
    expect(resolveListingDirectoryForBlock(compound, parentCwd)).toBe("C:\\");
    expect(joinListingEntryPath("C:\\", "Common Files")).toBe("C:\\Common Files");
  });

  it("条目名已是绝对路径时不再拼接列表目录", () => {
    expect(joinListingEntryPath("C:\\Program Files (x86)", "C:\\Common Files")).toBe(
      "C:\\Common Files",
    );
  });

  it("cd / 后列表点击 Users 跳转到盘符根下 Users", () => {
    const compound = "cd /; if ($?) { ls }";
    const homeCwd = "C:\\Users\\chaoj";
    expect(resolveListingDirectoryForBlock(compound, homeCwd)).toBe("C:\\");
    expect(joinListingEntryPath("C:\\", "Users")).toBe("C:\\Users");
  });

  it("cd ~ 从 PS 提示符解析列表目录", () => {
    const output = [
      "    目录: C:\\Users\\chaoj",
      "",
      "Mode                 LastWriteTime         Length Name",
      "d-----        2025/1/1     12:00                .cursor",
      "PS C:\\Users\\chaoj>",
    ].join("\r\n");
    const listingDir = resolveListingDirectoryForBlock(
      "cd ~; if ($?) { ls }",
      "C:\\AppGallery",
      null,
      output,
    );
    expect(listingDir).toBe("C:\\Users\\chaoj");
    expect(joinListingEntryPath(listingDir, "华为云盘")).toBe("C:\\Users\\chaoj\\华为云盘");
  });

  it("错误默认 ~/workspace 时从列表头解析实际目录", () => {
    const output = [
      "    目录: C:\\Users\\chaoj",
      "",
      "Mode                 LastWriteTime         Length Name",
      "d-----        2025/1/1     12:00                .cursor",
    ].join("\r\n");
    const listingDir = resolveListingDirectoryForBlock("ls", "~/workspace", null, output);
    expect(listingDir).toBe("C:\\Users\\chaoj");
    expect(joinListingEntryPath(listingDir, "华为云盘")).toBe("C:\\Users\\chaoj\\华为云盘");
  });

  it("~/workspace 在已知主目录 hint 下可展开", () => {
    expect(
      resolveLsListingDirectory("ls", "~/workspace", null, ["C:\\Users\\chaoj"]),
    ).toBe("C:\\Users\\chaoj\\workspace");
  });
});

describe("enrichLsListingWithSftp", () => {
  const baseListing: LsListing = {
    layout: "grid",
    entries: [
      { name: "docker", kind: "directory" },
      { name: "Makefile", kind: "directory" },
      { name: "demo.py", kind: "code" },
    ],
  };

  it("用 SFTP isDir 修正无扩展名条目", () => {
    const enriched = enrichLsListingWithSftp(baseListing, [
      { name: "docker", isDir: false, isSymlink: false, linkTarget: null, size: 42 },
      { name: "Makefile", isDir: false, isSymlink: false, linkTarget: null, size: 128 },
      { name: "demo.py", isDir: false, isSymlink: false, linkTarget: null, size: 256 },
    ]);

    const kinds = Object.fromEntries(enriched.entries.map((entry) => [entry.name, entry.kind]));
    expect(kinds.docker).toBe("file");
    expect(kinds.Makefile).toBe("file");
    expect(kinds["demo.py"]).toBe("code");
  });

  it("确认目录型符号链接可点击", () => {
    const enriched = enrichLsListingWithSftp(
      {
        layout: "grid",
        entries: [{ name: "lib", kind: "file" }],
      },
      [{ name: "lib", isDir: true, isSymlink: true, linkTarget: "usr/lib", size: 7 }],
    );

    expect(enriched.entries[0]?.kind).toBe("symlink");
    expect(enriched.entries[0]?.navigable).toBe(true);
  });

  it("长格式列表不做修正", () => {
    const longListing: LsListing = {
      layout: "long",
      entries: [{ name: "projects", kind: "directory" }],
    };
    const enriched = enrichLsListingWithSftp(longListing, [
      { name: "projects", isDir: false, isSymlink: false, linkTarget: null, size: 1 },
    ]);
    expect(enriched).toBe(longListing);
  });
});
