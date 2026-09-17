import { describe, expect, it } from "vitest";
import {
  expandAncestorIds,
  isInsideMirrorSubtree,
  isKnowledgeImported,
  isMirrorLocked,
  isMirrorSourceRoot,
  isObsidianMirrorEntry,
  isPdfImportEntry,
  isReadonlyMirrorEntry,
  isSiyuanMirrorEntry,
  mirrorNamespaceOf,
} from "./knowledgeTree";
import type { KnowledgeEntry } from "../../ipc/bindings";

function entry(partial: Partial<KnowledgeEntry> & { id: string; source: string }): KnowledgeEntry {
  return {
    kind: "note",
    title: partial.id,
    content: "",
    tags: [],
    riskLevel: "safe",
    envTag: "dev",
    language: "",
    usageCount: 0,
    createdAt: 0,
    updatedAt: 0,
    parentId: "",
    nodeType: "document",
    sortOrder: 0,
    resourceType: "",
    resourceId: "",
    ...partial,
  } as KnowledgeEntry;
}

describe("思源镜像与 PDF 导入判定", () => {
  it("import:siyuan: 是镜像不是 PDF", () => {
    const e = { source: "import:siyuan:doc:b1/d1" };
    expect(isKnowledgeImported(e)).toBe(true);
    expect(isSiyuanMirrorEntry(e)).toBe(true);
    expect(isPdfImportEntry(e)).toBe(false);
    expect(isReadonlyMirrorEntry(e)).toBe(true);
    expect(isMirrorLocked(e)).toBe(true);
  });

  it("import:siyuan-s3: 是镜像不是 PDF", () => {
    const e = { source: "import:siyuan-s3:doc:b1/d1" };
    expect(isSiyuanMirrorEntry(e)).toBe(true);
    expect(isPdfImportEntry(e)).toBe(false);
    expect(isReadonlyMirrorEntry(e)).toBe(true);
    expect(isMirrorLocked(e)).toBe(true);
    expect(mirrorNamespaceOf(e)).toBe("siyuan-s3");
  });

  it("obsidian 进只读镜像，不进 PDF 分支", () => {
    const e = { source: "import:ks:obsidian:doc:vault/d1" };
    expect(isObsidianMirrorEntry(e)).toBe(true);
    expect(isPdfImportEntry(e)).toBe(false);
    expect(isReadonlyMirrorEntry(e)).toBe(true);
    expect(isMirrorLocked(e)).toBe(true);
  });

  it("import:pdf: 是 PDF 不是镜像", () => {
    const e = { source: "import:pdf:C:\\docs\\a.pdf" };
    expect(isKnowledgeImported(e)).toBe(true);
    expect(isSiyuanMirrorEntry(e)).toBe(false);
    expect(isPdfImportEntry(e)).toBe(true);
    expect(isReadonlyMirrorEntry(e)).toBe(false);
    expect(isMirrorLocked(e)).toBe(false);
  });

  it("自建文档都不是", () => {
    const e = { source: "manual" };
    expect(isKnowledgeImported(e)).toBe(false);
    expect(isSiyuanMirrorEntry(e)).toBe(false);
    expect(isPdfImportEntry(e)).toBe(false);
    expect(isMirrorLocked(e)).toBe(false);
    expect(mirrorNamespaceOf(e)).toBeNull();
  });
});

describe("统一树镜像 helper", () => {
  const entries = [
    entry({ id: "u1", source: "manual", nodeType: "folder" }),
    entry({ id: "box", source: "import:siyuan:box:b1", nodeType: "folder" }),
    entry({ id: "d1", source: "import:siyuan:doc:b1/d1", parentId: "box" }),
    entry({ id: "d2", source: "import:siyuan:doc:b1/d2", parentId: "d1" }),
    entry({ id: "pdf", source: "import:pdf:C:\\a.pdf", parentId: "u1" }),
  ];

  it("来源根只认顶级导入文件夹", () => {
    const byId = new Map(entries.map((e) => [e.id, e]));
    expect(isMirrorSourceRoot(byId.get("box")!)).toBe(true);
    expect(isMirrorSourceRoot(byId.get("u1")!)).toBe(false);
    expect(isMirrorSourceRoot(byId.get("d1")!)).toBe(false);
  });

  it("祖先链展开防环", () => {
    expect(expandAncestorIds(entries, "d2")).toEqual(["d1", "box"]);
    expect(expandAncestorIds(entries, "box")).toEqual([]);
    const cyclic = [
      entry({ id: "a", source: "manual", parentId: "b" }),
      entry({ id: "b", source: "manual", parentId: "a" }),
    ];
    expect(expandAncestorIds(cyclic, "a")).toEqual(["b"]);
  });

  it("镜像子树判定含自身与误入的手动文档", () => {
    expect(isInsideMirrorSubtree("d2", entries)).toBe(true);
    expect(isInsideMirrorSubtree("box", entries)).toBe(true);
    expect(isInsideMirrorSubtree("u1", entries)).toBe(false);
    const stray = [
      ...entries,
      entry({ id: "stray", source: "manual", parentId: "box" }),
    ];
    expect(isInsideMirrorSubtree("stray", stray)).toBe(true);
    expect(isInsideMirrorSubtree("pdf", entries)).toBe(false);
    expect(isInsideMirrorSubtree("missing", entries)).toBe(false);
  });

  it("命名空间提取", () => {
    expect(mirrorNamespaceOf({ source: "import:siyuan:doc:b/d" })).toBe("siyuan");
    expect(mirrorNamespaceOf({ source: "import:pdf:C:\\a.pdf" })).toBe("pdf");
  });
});
