import { describe, expect, it } from "vitest";

import { createDefaultFilter, getVisibleNames, mergeFilter } from "./schemaFilterState";

describe("mergeFilter", () => {
  it("首次无过滤状态时默认全部可见", () => {
    const filter = mergeFilter(undefined, ["a", "b"]);
    expect(getVisibleNames(["a", "b"], filter)).toEqual(["a", "b"]);
  });

  it("刷新后新发现的名称默认可见，并按字母序重排", () => {
    const existing = createDefaultFilter(["users", "orders"]);
    const next = mergeFilter(existing, ["users", "orders", "new_table"]);
    expect(next.visibleNames.has("new_table")).toBe(true);
    expect(next.orderedNames).toEqual(["new_table", "orders", "users"]);
    expect(getVisibleNames(["users", "orders", "new_table"], next)).toEqual([
      "new_table",
      "orders",
      "users",
    ]);
  });

  it("无新增且非手动刷新时保留用户自定义顺序", () => {
    const existing = createDefaultFilter(["zebra", "apple"]);
    existing.orderedNames = ["zebra", "apple"];
    const next = mergeFilter(existing, ["zebra", "apple"]);
    expect(next.orderedNames).toEqual(["zebra", "apple"]);
  });

  it("手动刷新 showAll 时即使无新增也按字母重排", () => {
    const existing = createDefaultFilter(["zebra", "apple"]);
    existing.orderedNames = ["zebra", "apple"];
    const next = mergeFilter(existing, ["zebra", "apple"], { showAll: true });
    expect(next.orderedNames).toEqual(["apple", "zebra"]);
  });

  it("有新表时未置顶项重排，置顶项仍保持在前", () => {
    const existing = createDefaultFilter(["users", "orders"]);
    existing.pinnedNames = ["users"];
    existing.orderedNames = ["users", "orders"];
    const next = mergeFilter(existing, ["users", "orders", "alpha_table"]);
    expect(next.orderedNames).toEqual(["users", "alpha_table", "orders"]);
  });

  it("手动刷新 showAll 时置顶项仍保持在前并重排其余项", () => {
    const existing = createDefaultFilter(["zebra", "apple", "mango"]);
    existing.pinnedNames = ["zebra"];
    existing.orderedNames = ["zebra", "mango", "apple"];
    const next = mergeFilter(existing, ["zebra", "apple", "mango"], { showAll: true });
    expect(next.orderedNames).toEqual(["zebra", "apple", "mango"]);
  });

  it("保留用户主动隐藏的项，不因刷新把已隐藏项重新打开", () => {
    const existing = createDefaultFilter(["users", "orders", "legacy"]);
    existing.visibleNames.delete("legacy");
    const next = mergeFilter(existing, ["users", "orders", "legacy", "new_table"]);
    expect(next.visibleNames.has("legacy")).toBe(false);
    expect(next.visibleNames.has("new_table")).toBe(true);
    expect(getVisibleNames(["users", "orders", "legacy", "new_table"], next)).toEqual([
      "new_table",
      "orders",
      "users",
    ]);
  });

  it("手动刷新 showAll 时把已隐藏项也重新显示", () => {
    const existing = createDefaultFilter(["users", "orders", "legacy"]);
    existing.visibleNames.delete("legacy");
    const next = mergeFilter(existing, ["users", "orders", "legacy", "new_table"], {
      showAll: true,
    });
    expect(next.visibleNames.has("legacy")).toBe(true);
    expect(next.visibleNames.has("new_table")).toBe(true);
  });

  it("名称全部被移除后回退为全部可见", () => {
    const existing = createDefaultFilter(["gone"]);
    existing.visibleNames.clear();
    const next = mergeFilter(existing, ["fresh"]);
    expect(getVisibleNames(["fresh"], next)).toEqual(["fresh"]);
  });
});
