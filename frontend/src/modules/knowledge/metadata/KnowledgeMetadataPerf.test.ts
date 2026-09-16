import { describe, expect, it } from "vitest";
import {
  buildKnowledgeMetadata,
  computeUnlinkedMentionsFor,
} from "./KnowledgeMetadataCache";
import type { KnowledgeEntry } from "../../../ipc/bindings";

function makeEntries(n: number): KnowledgeEntry[] {
  const out: KnowledgeEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `doc-${i}`,
      kind: "note",
      title: `文档标题${i}号`,
      content: `这是第${i}篇文档的正文内容，`.repeat(60) + `提到文档标题${(i + 1) % n}号`,
      tags: ["siyuan"],
      riskLevel: "safe",
      source: "import:siyuan:doc:b/d",
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
    } as KnowledgeEntry);
  }
  return out;
}

describe("400 文档性能", () => {
  it("全量构建 + 单篇懒算都在毫秒级", () => {
    const entries = makeEntries(400);
    const t0 = performance.now();
    const snapshot = buildKnowledgeMetadata(entries);
    const tBuild = performance.now() - t0;
    const t1 = performance.now();
    const mentions = computeUnlinkedMentionsFor(entries, snapshot, "doc-0");
    const tLazy = performance.now() - t1;
    console.log(`build=${tBuild.toFixed(0)}ms lazy=${tLazy.toFixed(0)}ms mentions=${mentions.length}`);
    expect(tBuild).toBeLessThan(1500);
    expect(tLazy).toBeLessThan(500);
    expect(mentions.length).toBeGreaterThan(0);
  });
});
