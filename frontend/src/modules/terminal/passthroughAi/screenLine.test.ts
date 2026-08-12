import { describe, expect, it } from "vitest";
import {
  lineLooksLikeShellPrompt,
  promptPrefixEndIndex,
  splitPromptAndBody,
  stripShellPromptPrefix,
} from "./screenLine";

describe("lineLooksLikeShellPrompt", () => {
  it("识别 bash root 主提示符", () => {
    expect(lineLooksLikeShellPrompt("root@iZ2ze6kzua54dfh8v7jxo6Z:~#")).toBe(true);
    expect(lineLooksLikeShellPrompt("root@host:~# ")).toBe(true);
  });

  it("空行 / 无提示符不算", () => {
    expect(lineLooksLikeShellPrompt("")).toBe(false);
    expect(lineLooksLikeShellPrompt("   ")).toBe(false);
    expect(lineLooksLikeShellPrompt("Connecting...")).toBe(false);
  });

  it("识别 PowerShell 主提示符", () => {
    expect(lineLooksLikeShellPrompt("PS C:\\Users\\chaoj>")).toBe(true);
    expect(lineLooksLikeShellPrompt("PS C:\\Users\\chaoj> ")).toBe(true);
  });

  it("PowerShell 续行提示不算主提示符", () => {
    expect(lineLooksLikeShellPrompt(">>")).toBe(false);
    expect(lineLooksLikeShellPrompt(">> ")).toBe(false);
  });

  it("已有正文的提示行不算等待输入", () => {
    // 带正文时末尾不是提示符符，启发式应返回 false
    expect(lineLooksLikeShellPrompt("root@host:~# ls")).toBe(false);
  });
});

describe("stripShellPromptPrefix", () => {
  it("剥掉 bash root 提示符", () => {
    expect(stripShellPromptPrefix("root@cszn:~# 当前的时间")).toBe("当前的时间");
  });

  it("剥掉 user $ 提示符", () => {
    expect(stripShellPromptPrefix("admin@host:~$ ls -la")).toBe("ls -la");
  });

  it("剥掉 PowerShell 提示符", () => {
    expect(stripShellPromptPrefix("PS C:\\Users\\chaoj> 现在的时间")).toBe("现在的时间");
    expect(stripShellPromptPrefix("PS C:\\Users\\chaoj>")).toBe("");
  });

  it("无提示符时原样", () => {
    expect(stripShellPromptPrefix("当前的时间")).toBe("当前的时间");
  });

  it("空提示符且 # 后无空格 → 正文为空", () => {
    expect(stripShellPromptPrefix("root@iZm5edx67vmzvg5n6u5klpZ:~#")).toBe("");
    expect(stripShellPromptPrefix("root@host:~#")).toBe("");
    expect(stripShellPromptPrefix("admin@host:~$")).toBe("");
  });

  it("无空格分隔的正文也能剥", () => {
    expect(stripShellPromptPrefix("root@host:~#你好")).toBe("你好");
  });
});

describe("promptPrefixEndIndex / splitPromptAndBody", () => {
  it("阿里长主机名提示符：正文起点在 $ 后", () => {
    const line = "admin@iZ2zefxej96yf41ycjnbgcZ:~$ 当前的时间";
    const end = promptPrefixEndIndex(line);
    expect(line.slice(end)).toBe("当前的时间");
    expect(splitPromptAndBody(line)).toEqual({
      prefix: "admin@iZ2zefxej96yf41ycjnbgcZ:~$ ",
      body: "当前的时间",
    });
  });
});
