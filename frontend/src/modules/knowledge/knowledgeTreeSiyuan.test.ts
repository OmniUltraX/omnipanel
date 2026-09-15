import { describe, expect, it } from "vitest";
import {
  isKnowledgeImported,
  isPdfImportEntry,
  isSiyuanMirrorEntry,
} from "./knowledgeTree";

describe("思源镜像与 PDF 导入判定", () => {
  it("import:siyuan: 是镜像不是 PDF", () => {
    const entry = { source: "import:siyuan:doc:b1/d1" };
    expect(isKnowledgeImported(entry)).toBe(true);
    expect(isSiyuanMirrorEntry(entry)).toBe(true);
    expect(isPdfImportEntry(entry)).toBe(false);
  });

  it("import:pdf: 是 PDF 不是镜像", () => {
    const entry = { source: "import:pdf:C:\\docs\\a.pdf" };
    expect(isKnowledgeImported(entry)).toBe(true);
    expect(isSiyuanMirrorEntry(entry)).toBe(false);
    expect(isPdfImportEntry(entry)).toBe(true);
  });

  it("自建文档都不是", () => {
    const entry = { source: "manual" };
    expect(isKnowledgeImported(entry)).toBe(false);
    expect(isSiyuanMirrorEntry(entry)).toBe(false);
    expect(isPdfImportEntry(entry)).toBe(false);
  });
});
