import { describe, expect, it, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePersistedTreeExpanded } from "./usePersistedTreeExpanded";

const KEY = "test-module-sidebar-tree-expanded";

describe("usePersistedTreeExpanded", () => {
  beforeEach(() => {
    localStorage.removeItem(KEY);
  });

  it("toggle / isExpanded 默认折叠", () => {
    const { result } = renderHook(() => usePersistedTreeExpanded(KEY));
    expect(result.current.isExpanded("a")).toBe(false);
    act(() => result.current.toggle("a"));
    expect(result.current.isExpanded("a")).toBe(true);
    act(() => result.current.toggle("a"));
    expect(result.current.isExpanded("a")).toBe(false);
  });

  it("重启后从 localStorage 恢复", () => {
    const first = renderHook(() => usePersistedTreeExpanded(KEY));
    act(() => first.result.current.ensureExpanded("a"));
    first.unmount();

    const second = renderHook(() => usePersistedTreeExpanded(KEY));
    expect(second.result.current.isExpanded("a")).toBe(true);
  });

  it("set 直接赋值（默认展开语义的 toggle 自行取反）", () => {
    const { result } = renderHook(() => usePersistedTreeExpanded(KEY));
    // 未记录的 key 默认折叠，set(true) 后展开
    act(() => result.current.set("a", true));
    expect(result.current.isExpanded("a")).toBe(true);
    expect(result.current.isExpanded("a", true)).toBe(true);
    act(() => result.current.set("a", false));
    expect(result.current.isExpanded("a", true)).toBe(false);
  });

  it("setAllExpanded 批量展开、collapseAll 清空", () => {
    const { result } = renderHook(() => usePersistedTreeExpanded(KEY));
    act(() => result.current.setAllExpanded(["a", "b"], true));
    expect(result.current.isExpanded("a")).toBe(true);
    expect(result.current.isExpanded("b")).toBe(true);
    act(() => result.current.collapseAll());
    expect(result.current.isExpanded("a")).toBe(false);
    expect(result.current.isExpanded("b")).toBe(false);
    expect(localStorage.getItem(KEY)).toBe("{}");
  });
});
