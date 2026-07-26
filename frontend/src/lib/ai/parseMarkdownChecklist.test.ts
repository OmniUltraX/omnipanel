import { describe, expect, it } from "vitest";
import { parseMarkdownChecklist, textFromMessageParts } from "./parseMarkdownChecklist";

describe("parseMarkdownChecklist", () => {
  it("解析标题与勾选状态", () => {
    const parsed = parseMarkdownChecklist(`## 本周运维

- [ ] 检查 Nginx
- [x] 备份配置
* [ ] 轮转证书
`);
    expect(parsed?.title).toBe("本周运维");
    expect(parsed?.items).toEqual([
      { text: "检查 Nginx", done: false },
      { text: "备份配置", done: true },
      { text: "轮转证书", done: false },
    ]);
  });

  it("无勾选时返回 null", () => {
    expect(parseMarkdownChecklist("只是一段说明")).toBeNull();
  });

  it("textFromMessageParts 拼接 text", () => {
    expect(
      textFromMessageParts([
        { type: "text", text: "a" },
        { type: "reasoning", text: " Ignored" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
  });
});
