import { describe, expect, it } from "vitest";
import { extractFencedBlocks } from "./scaffoldFormat";

describe("studio AI 围栏解析", () => {
  it("三段齐全时映射到三文件", () => {
    const out = [
      "```plugin.json",
      '{"id":"omni.sample.x"}',
      "```",
      "```main.js",
      "module.exports = 1;",
      "```",
      "```index.html",
      "<div>hi</div>",
      "```",
    ].join("\n");
    expect(extractFencedBlocks(out)).toEqual({
      "plugin.json": '{"id":"omni.sample.x"}',
      "ui/main.js": "module.exports = 1;",
      "ui/index.html": "<div>hi</div>",
    });
  });

  it("缺段时只返回有的", () => {
    expect(extractFencedBlocks("```js\n1\n```")).toEqual({ "ui/main.js": "1" });
    expect(extractFencedBlocks("no fences")).toEqual({});
  });
});
