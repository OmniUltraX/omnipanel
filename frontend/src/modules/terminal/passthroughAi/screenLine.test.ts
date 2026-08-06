import { describe, expect, it } from "vitest";
import {
  promptPrefixEndIndex,
  splitPromptAndBody,
  stripShellPromptPrefix,
} from "./screenLine";

describe("stripShellPromptPrefix", () => {
  it("剥掉 bash root 提示符", () => {
    expect(stripShellPromptPrefix("root@cszn:~# 当前的时间")).toBe("当前的时间");
  });

  it("剥掉 user $ 提示符", () => {
    expect(stripShellPromptPrefix("admin@host:~$ ls -la")).toBe("ls -la");
  });

  it("无提示符时原样", () => {
    expect(stripShellPromptPrefix("当前的时间")).toBe("当前的时间");
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
