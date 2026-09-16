import { describe, expect, it } from "vitest";
import {
  buildKnowledgeMetadata,
  computeUnlinkedMentionsFor,
} from "./KnowledgeMetadataCache";
import type { KnowledgeEntry } from "../../../ipc/bindings";

function entry(partial: Partial<KnowledgeEntry> & { id: string }): KnowledgeEntry {
  return {
    kind: "note",
    title: "",
    content: "",
    tags: [],
    riskLevel: "safe",
    source: "manual",
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

describe("未链接提及懒算", () => {
  const entries = [
    entry({ id: "a", title: "Alpha", content: "提到 Beta 的正文" }),
    entry({ id: "b", title: "Beta", content: "无关内容" }),
    entry({ id: "c", title: "Gamma", content: "[[Beta]] 已链接" }),
  ];

  it("只算目标文档：未链接命中、已链接排除", () => {
    const snapshot = buildKnowledgeMetadata(entries);
    // 全量构建不再含未链接（防 O(n²) 卡首屏）。
    expect(snapshot.unlinkedMentions.size).toBe(0);
    const mentions = computeUnlinkedMentionsFor(entries, snapshot, "b");
    expect(mentions.map((m) => m.sourceId)).toEqual(["a"]);
    expect(mentions[0].snippet).toContain("Beta");
  });

  it("短标题与缺失文档直接返回空", () => {
    const snapshot = buildKnowledgeMetadata(entries);
    expect(computeUnlinkedMentionsFor(entries, snapshot, "missing")).toEqual([]);
    const short = [...entries, entry({ id: "s", title: "X", content: "x" })];
    const snapshot2 = buildKnowledgeMetadata(short);
    expect(computeUnlinkedMentionsFor(short, snapshot2, "s")).toEqual([]);
  });

  it("反链仍在全量构建中（线性）", () => {
    const snapshot = buildKnowledgeMetadata(entries);
    expect(snapshot.backlinks.get("b")?.map((m) => m.sourceId)).toEqual(["c"]);
  });
});
