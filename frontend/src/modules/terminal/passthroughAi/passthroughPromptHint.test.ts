import { describe, expect, it } from "vitest";

import { passthroughPromptHintEligibleScreenLine } from "./passthroughPromptHint";

describe("passthroughPromptHintEligibleScreenLine", () => {
  it("空提示符可显示灰色占位", () => {
    expect(passthroughPromptHintEligibleScreenLine("root@cszn:~# ")).toBe(true);
    expect(passthroughPromptHintEligibleScreenLine("root@cszn:~#")).toBe(true);
    expect(passthroughPromptHintEligibleScreenLine("PS C:\\Users\\chaoj> ")).toBe(true);
  });

  it("路径点击 cd 回显后不再显示", () => {
    expect(passthroughPromptHintEligibleScreenLine("root@cszn:~# cd '/root' && ls")).toBe(false);
    expect(passthroughPromptHintEligibleScreenLine("root@cszn:~# cd '/root'")).toBe(false);
  });

  it("用户正在输入命令时不显示", () => {
    expect(passthroughPromptHintEligibleScreenLine("root@host:~# ls -la")).toBe(false);
    expect(passthroughPromptHintEligibleScreenLine("root@host:~# 现在的时间")).toBe(false);
  });

  it("普通输出行不显示", () => {
    expect(passthroughPromptHintEligibleScreenLine("total 128")).toBe(false);
  });
});
