import { describe, expect, it } from "vitest";
import {
  actionTarget,
  capabilityDetail,
  capabilityItemKey,
  capabilityLabel,
  capabilityListMethod,
  capabilityPane,
  extractFacts,
  extractItems,
  extractMetrics,
  extractTree,
  isProtectedRow,
  mergeTreeChildren,
  rowItemKey,
} from "./moduleHostContract";

describe("moduleHostContract", () => {
  it("优先用清单 label / listMethod", () => {
    expect(
      capabilityLabel({ id: "topic", label: "主题" }, (key) => key),
    ).toBe("主题");
    expect(capabilityListMethod({ id: "topic", columns: [], actions: [], listMethod: "listTopics" })).toBe(
      "listTopics",
    );
    expect(capabilityItemKey({ id: "topic", columns: [], actions: [] })).toBe("id");
    expect(capabilityDetail({ id: "topic", columns: [], actions: [] })).toBe("none");
  });

  it("兼容 Nacos 旧方法名", () => {
    expect(capabilityListMethod({ id: "config", columns: [], actions: [] })).toBe("listConfigs");
    expect(capabilityItemKey({ id: "config", columns: [], actions: [] })).toBe("group,dataId");
    expect(capabilityDetail({ id: "config", columns: [], actions: [] })).toBe("editor");
    expect(actionTarget({ id: "publish" }, "editor")).toBe("editor");
    expect(actionTarget({ id: "create" }, "none")).toBe("toolbar");
    expect(rowItemKey({ group: "DEFAULT_GROUP", dataId: "app.yaml" }, "group,dataId")).toBe(
      "DEFAULT_GROUP:app.yaml",
    );
    expect(isProtectedRow({ namespaceId: "" }, "namespaceId")).toBe(true);
  });

  it("抽出 items", () => {
    expect(extractItems({ items: [{ id: "a" }] })).toEqual([{ id: "a" }]);
    expect(extractItems([{ id: "b" }])).toEqual([{ id: "b" }]);
  });

  it("form / logs / metrics / facts 壳", () => {
    expect(capabilityPane({ id: "user", columns: [], actions: [], detail: "form" })).toBe("form");
    expect(capabilityPane({ id: "keys", columns: [], actions: [], detail: "kv" })).toBe("kv");
    expect(capabilityPane({ id: "audit", columns: [], actions: [], detail: "logs" })).toBe("logs");
    expect(extractFacts({ facts: { version: "1", auth: "basic" } })).toEqual([
      { key: "version", value: "1" },
      { key: "auth", value: "basic" },
    ]);
    expect(
      extractMetrics({
        items: [{ id: "cpu", unit: "%", points: [{ tsMs: 1, value: 12 }] }],
      }),
    ).toEqual([{ id: "cpu", label: "cpu", unit: "%", points: [{ tsMs: 1, value: 12 }] }]);
  });

  it("拼出树并合并懒加载子节点", () => {
    expect(capabilityPane({ id: "keys", columns: [], actions: [], detail: "tree" })).toBe("tree");
    const nested = extractTree({
      items: [{ id: "a", label: "A", children: [{ id: "a/b", name: "B", leaf: true }] }],
    });
    expect(nested).toMatchObject([{ id: "a", label: "A", leaf: false, children: [{ id: "a/b", label: "B", leaf: true }] }]);
    const flat = extractTree({
      items: [
        { id: "root", name: "root", hasChildren: true },
        { id: "child", name: "child", parentId: "root", leaf: true },
      ],
    });
    expect(flat[0]?.children[0]?.id).toBe("child");
    const merged = mergeTreeChildren(
      [{ id: "root", label: "root", leaf: false, children: [], raw: { id: "root" } }],
      "root",
      [{ id: "k", label: "k", leaf: true, children: [], raw: { id: "k" } }],
    );
    expect(merged[0]?.children).toHaveLength(1);
  });
});
