import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStatusBarLogStore } from "./statusBarLogStore";

describe("statusBarLogStore auto-clear", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStatusBarLogStore.setState({ activePublisher: "database", logsByModule: {} });
    useStatusBarLogStore.getState().clear("database");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears success after 4s and errors after 8s", () => {
    const store = useStatusBarLogStore.getState();
    store.publish("database", "Schema 缓存刷新完成", "success");
    vi.advanceTimersByTime(3999);
    expect(useStatusBarLogStore.getState().logsByModule.database?.message).toBe(
      "Schema 缓存刷新完成",
    );
    vi.advanceTimersByTime(1);
    expect(useStatusBarLogStore.getState().logsByModule.database).toBeUndefined();

    useStatusBarLogStore.getState().publish(
      "database",
      "刷新 GUI sample SQLite 失败：Error: 解析 db_refresh_schema_node 失败: missing field `connection`",
      "error",
    );
    vi.advanceTimersByTime(7999);
    expect(useStatusBarLogStore.getState().logsByModule.database?.level).toBe("error");
    vi.advanceTimersByTime(1);
    expect(useStatusBarLogStore.getState().logsByModule.database).toBeUndefined();
  });

  it("does not auto-clear in-flight progress", () => {
    useStatusBarLogStore.getState().publish("database", "正在刷新 Schema 缓存…", "progress");
    vi.advanceTimersByTime(20_000);
    expect(useStatusBarLogStore.getState().logsByModule.database?.level).toBe("progress");
  });
});
