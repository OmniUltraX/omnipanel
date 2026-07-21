import { describe, expect, it } from "vitest";

import { mergeAiContextAppend } from "./composerContextAppend";
import { parseModuleContextChipLabel } from "./parseModuleContextChip";
import { resolveFocusModuleKey } from "./resolveFocusModuleKey";

describe("resolveFocusModuleKey", () => {
  it("maps dockScope prefixes to module keys", () => {
    expect(resolveFocusModuleKey("terminal:main")).toBe("terminal");
    expect(resolveFocusModuleKey("database-workspace")).toBe("database");
    expect(resolveFocusModuleKey("docker")).toBe("docker");
    expect(resolveFocusModuleKey("files")).toBe("files");
    expect(resolveFocusModuleKey("file-browser")).toBe("files");
    expect(resolveFocusModuleKey("ssh-host")).toBe("ssh");
    expect(resolveFocusModuleKey("server-panel")).toBe("ssh");
    expect(resolveFocusModuleKey("unknown")).toBeNull();
    expect(resolveFocusModuleKey(null)).toBeNull();
  });
});

describe("parseModuleContextChipLabel", () => {
  it("parses Chinese module context sections", () => {
    const text = ["## SSH 主机上下文", "- 主机：p8", "- 地址：root@1.2.3.4"].join("\n");
    expect(parseModuleContextChipLabel(text)).toBe("SSH 主机上下文 · p8 · root@1.2.3.4");
  });

  it("parses database context", () => {
    const text = ["## 数据库模块上下文", "- 连接名称：local-mysql", "- 当前数据库：app"].join(
      "\n",
    );
    expect(parseModuleContextChipLabel(text)).toContain("数据库");
    expect(parseModuleContextChipLabel(text)).toContain("local-mysql");
  });
});

describe("mergeAiContextAppend", () => {
  it("joins non-empty parts", () => {
    expect(mergeAiContextAppend("a", null, "b")).toBe("a\n\n---\n\nb");
    expect(mergeAiContextAppend(null, "  ", undefined)).toBeNull();
  });
});
