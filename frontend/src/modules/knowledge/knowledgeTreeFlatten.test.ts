import { describe, expect, it } from "vitest";
import {
  buildKnowledgeTree,
  collectDescendantIds,
  flattenVisibleTree,
} from "./knowledgeTree";
import type { KnowledgeEntry } from "../../ipc/bindings";

function entry(partial: Partial<KnowledgeEntry> & { id: string }): KnowledgeEntry {
  return {
    kind: "note",
    title: partial.id,
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

describe("flattenVisibleTree", () => {
  const entries = [
    entry({ id: "f1", title: "文件夹", nodeType: "folder", sortOrder: 0 }),
    entry({ id: "d1", title: "文档一", parentId: "f1", sortOrder: 0 }),
    entry({ id: "d2", title: "文档二", parentId: "f1", sortOrder: 1 }),
    entry({ id: "root", title: "根文档", sortOrder: 1 }),
  ];

  it("折叠时只含顶层行", () => {
    const rows = flattenVisibleTree(buildKnowledgeTree(entries), []);
    expect(rows.map((r) => r.node.entry.id)).toEqual(["f1", "root"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0]);
  });

  it("展开输出子行并带深度", () => {
    const rows = flattenVisibleTree(buildKnowledgeTree(entries), ["f1"]);
    expect(rows.map((r) => r.node.entry.id)).toEqual(["f1", "d1", "d2", "root"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 0]);
  });

  it("文档带子项时也可展开（思源子文档镜像）", () => {
    const nested = [
      entry({ id: "box", title: "笔记本", nodeType: "folder", sortOrder: 0 }),
      entry({ id: "p", title: "父文档", parentId: "box", sortOrder: 0 }),
      entry({ id: "c", title: "子文档", parentId: "p", sortOrder: 0 }),
    ];
    const tree = buildKnowledgeTree(nested);
    // 父文档节点必须挂住子项，不再被丢弃。
    expect(tree[0].children[0].children.map((n) => n.entry.id)).toEqual(["c"]);
    const rows = flattenVisibleTree(tree, ["box", "p"]);
    expect(rows.map((r) => r.node.entry.id)).toEqual(["box", "p", "c"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
  });

  it("无子项文档的 expandedId 仍无行变化", () => {
    const rows = flattenVisibleTree(buildKnowledgeTree(entries), ["root"]);
    expect(rows.map((r) => r.node.entry.id)).toEqual(["f1", "root"]);
  });

  it("collectDescendantIds 穿过文档层且环形不死循环", () => {
    const nested = [
      entry({ id: "box", title: "笔记本", nodeType: "folder", sortOrder: 0 }),
      entry({ id: "p", title: "父文档", parentId: "box", sortOrder: 0 }),
      entry({ id: "c", title: "子文档", parentId: "p", sortOrder: 0 }),
    ];
    expect(collectDescendantIds(nested, "box")).toEqual(["p", "c"]);
    const cyclic = [
      entry({ id: "a", title: "A", parentId: "b", sortOrder: 0 }),
      entry({ id: "b", title: "B", parentId: "a", sortOrder: 0 }),
    ];
    // 环形时收敛不死循环（a 是 b 的后代、b 也是 a 的后代，各记一次）。
    expect(collectDescendantIds(cyclic, "a")).toEqual(["b", "a"]);
  });

  it("环形 parentId 不爆栈（A↔B 互指时截断）", () => {
    const cyclic = [
      entry({ id: "a", title: "A", nodeType: "folder", parentId: "b", sortOrder: 0 }),
      entry({ id: "b", title: "B", nodeType: "folder", parentId: "a", sortOrder: 0 }),
    ];
    // 根级无节点（互相挂载），但绝不能栈溢出。
    expect(buildKnowledgeTree(cyclic)).toEqual([]);
    // 直接对环形节点数组扁平化同样截断。
    const nodes = [
      {
        entry: cyclic[0],
        children: [{ entry: cyclic[1], children: [] }],
      },
    ];
    const rows = flattenVisibleTree(nodes, ["a", "b"]);
    expect(rows.map((r) => r.node.entry.id)).toEqual(["a", "b"]);
  });
});
