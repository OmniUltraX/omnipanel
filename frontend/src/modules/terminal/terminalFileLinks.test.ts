import { describe, expect, it } from "vitest";
import {
  buildPathLinkRange,
  classifyLinePathLinks,
  decidePathLinkAction,
  detectBareNameRanges,
  detectFilePathRanges,
  isPathLikeToken,
  isTypicalDirectoryColor,
  isXtermMouseTrackingOn,
  stripLsClassifySuffix,
} from "./terminalFileLinks";

const BASE = {
  cwd: "/root",
  sessionType: "remote" as const,
  remoteHome: "/root",
};

describe("detectFilePathRanges", () => {
  it("识别绝对路径与相对路径", () => {
    const ranges = detectFilePathRanges("see /etc/hosts and ./src/main.rs");
    expect(ranges.map((r) => r.text)).toEqual(["/etc/hosts", "./src/main.rs"]);
  });

  it("不把 URL 当成路径", () => {
    expect(detectFilePathRanges("https://example.com/foo").length).toBe(0);
  });
});

describe("stripLsClassifySuffix / color", () => {
  it("ls -F 目录带尾斜杠", () => {
    expect(stripLsClassifySuffix("src/")).toEqual({ name: "src", kindHint: "dir" });
  });

  it("ls -F 可执行文件带星号", () => {
    expect(stripLsClassifySuffix("a.out*")).toEqual({ name: "a.out", kindHint: "file" });
  });

  it("ANSI 蓝视为目录色", () => {
    expect(isTypicalDirectoryColor(4, true)).toBe(true);
    expect(isTypicalDirectoryColor(12, true)).toBe(true);
    expect(isTypicalDirectoryColor(2, true)).toBe(false);
    expect(isTypicalDirectoryColor(4, false)).toBe(false);
  });
});

describe("classifyLinePathLinks", () => {
  it("缓存命中后 ls 网格裸名可点，error 不误链", () => {
    const listing = [
      { name: "README.md", isDir: false },
      { name: "src", isDir: true },
    ];
    const links = classifyLinePathLinks({
      ...BASE,
      line: "README.md  src  error  /var/log/syslog",
      listing,
    });
    expect(links.map((l) => `${l.name}:${l.kind}`)).toEqual([
      "README.md:file",
      "src:dir",
      "syslog:file",
    ]);
  });

  it("缓存未就绪时普通单词 error 不是链接", () => {
    const links = classifyLinePathLinks({
      ...BASE,
      line: "command failed with error",
      listing: null,
    });
    expect(links).toEqual([]);
  });

  it("缓存未就绪时路径正则仍可识别", () => {
    const links = classifyLinePathLinks({
      ...BASE,
      line: "open /var/log/syslog please",
      listing: null,
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.kind).toBe("file");
    expect(links[0]?.absolutePath).toBe("/var/log/syslog");
  });

  it("bash 提示符 cwd 按面包屑分段，每段都是目录", () => {
    const line = "root@localhost:~/cache/mango/mood-calendar-service#";
    const links = classifyLinePathLinks({
      ...BASE,
      cwd: "/root/cache/mango/mood-calendar-service",
      remoteHome: null,
      line,
      listing: null,
    });
    expect(links.every((item) => item.kind === "dir")).toBe(true);
    expect(links.map((item) => item.text)).toEqual(["~", "cache", "mango", "mood-calendar-service"]);
    expect(links.map((item) => item.absolutePath)).toEqual([
      "/root",
      "/root/cache",
      "/root/cache/mango",
      "/root/cache/mango/mood-calendar-service",
    ]);
    expect(line.slice(links[0]!.start, links[0]!.end)).toBe("~");
    expect(line.slice(links[1]!.start, links[1]!.end)).toBe("cache");
  });

  it("提示符分段可点，正文路径仍可点", () => {
    const links = classifyLinePathLinks({
      ...BASE,
      cwd: "/root/cache",
      line: "root@localhost:~/cache# cat /etc/hosts",
      listing: null,
    });
    expect(links.map((item) => `${item.text}:${item.kind}:${item.absolutePath}`)).toEqual([
      "~:dir:/root",
      "cache:dir:/root/cache",
      "/etc/hosts:file:/etc/hosts",
    ]);
  });

  it("PowerShell 提示符路径按盘符分段", () => {
    const links = classifyLinePathLinks({
      cwd: "C:\\Users\\chaoj",
      sessionType: "local",
      remoteHome: null,
      line: "PS C:\\Users\\chaoj>",
      listing: null,
    });
    expect(links.every((item) => item.kind === "dir")).toBe(true);
    expect(links.map((item) => item.text)).toEqual(["C:", "Users", "chaoj"]);
    expect(links.map((item) => item.absolutePath)).toEqual([
      "C:\\",
      "C:\\Users",
      "C:\\Users\\chaoj",
    ]);
  });

  it("目录带尾 / 分类为 dir", () => {
    const links = classifyLinePathLinks({
      ...BASE,
      line: "cd ./apps/",
      listing: null,
    });
    expect(links[0]?.kind).toBe("dir");
    expect(links[0]?.name).toBe("apps");
  });

  it("cd 参数里的绝对路径是目录不是文件", () => {
    const links = classifyLinePathLinks({
      ...BASE,
      cwd: "/root/builds",
      line: "root@localhost:~# cd '/root/builds' && ls",
      listing: null,
    });
    expect(links).toEqual([
      expect.objectContaining({
        text: "~",
        kind: "dir",
        absolutePath: "/root",
      }),
      expect.objectContaining({
        kind: "dir",
        absolutePath: "/root/builds",
        name: "builds",
      }),
    ]);
  });

  it("列举缓存里同名目录时绝对路径按目录", () => {
    const links = classifyLinePathLinks({
      ...BASE,
      line: "see /root/builds",
      listing: [{ name: "builds", isDir: true }],
    });
    expect(links[0]?.kind).toBe("dir");
    expect(links[0]?.absolutePath).toBe("/root/builds");
  });

  it("目录色启发式可把裸名标成目录", () => {
    const line = "src  notes.txt";
    const links = classifyLinePathLinks({
      ...BASE,
      line,
      listing: null,
      isDirectoryColor: (start, end) => line.slice(start, end) === "src",
    });
    expect(links.map((l) => `${l.name}:${l.kind}`)).toEqual(["src:dir"]);
  });

  it("标志位 -la 不会被当成裸名", () => {
    const ranges = detectBareNameRanges("ls -la README.md", []);
    expect(ranges.map((r) => r.text)).toEqual(["ls", "README.md"]);
  });

  it("空闲时目录走 cd，忙碌时拦截；文件始终预览", () => {
    expect(decidePathLinkAction("dir", true)).toBe("cd");
    expect(decidePathLinkAction("dir", false)).toBe("cd-blocked");
    expect(decidePathLinkAction("file", false)).toBe("preview");
  });

  it("鼠标跟踪 mode 非 none 时让路", () => {
    expect(isXtermMouseTrackingOn({ modes: { mouseTrackingMode: "none" } })).toBe(false);
    expect(isXtermMouseTrackingOn({ modes: { mouseTrackingMode: "vt200" } })).toBe(true);
  });
});

describe("buildPathLinkRange", () => {
  it("使用 buffer 行号而不是写死 1", () => {
    const range = buildPathLinkRange(3, 10, 17);
    expect(range.start.y).toBe(17);
    expect(range.end.y).toBe(17);
    expect(range.start.x).toBe(4);
    expect(range.end.x).toBe(10);
  });
});

describe("isPathLikeToken", () => {
  it("裸名不是路径形态", () => {
    expect(isPathLikeToken("error")).toBe(false);
    expect(isPathLikeToken("/etc/hosts")).toBe(true);
  });
});
