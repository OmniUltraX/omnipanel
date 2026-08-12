import { describe, expect, it } from "vitest";
import {
  applyTablePreviewDataProgressive,
  beginTablePreviewFetch,
  bumpTablePreviewApplyGeneration,
  getTablePreviewApplyGeneration,
} from "./applyTablePreviewData";
import { createDefaultTablePreviewState } from "./dbWorkspaceState";
import {
  getTablePreviewRowCache,
  setTablePreviewRowCache,
} from "./tablePreviewRowCache";

describe("applyTablePreviewDataProgressive", () => {
  it("clears rows and cache when filter returns no rows in canvas mode", async () => {
    const tabId = "tab-empty-canvas";
    let previews: Record<string, ReturnType<typeof createDefaultTablePreviewState>> = {
      [tabId]: {
        ...createDefaultTablePreviewState(),
        data: {
          name: "users",
          columns: ["id"],
          rows: [{ id: 1 }, { id: 2 }],
        },
        totalRows: 2,
      },
    };

    const setTablePreviews = (
      updater:
        | typeof previews
        | ((prev: typeof previews) => typeof previews),
    ) => {
      previews =
        typeof updater === "function" ? updater(previews) : updater;
    };

    const generation = bumpTablePreviewApplyGeneration(tabId);
    setTablePreviewRowCache(tabId, {
      name: "users",
      columns: ["id"],
      rows: [{ id: 1 }, { id: 2 }],
    });

    await applyTablePreviewDataProgressive({
      tabId,
      data: { name: "users", columns: ["id"], rows: [] },
      totalRows: 0,
      page: 0,
      pageSize: 50,
      setTablePreviews,
      generation,
      canvasMode: true,
    });

    expect(previews[tabId]?.data?.rows).toEqual([]);
    expect(getTablePreviewRowCache(tabId)).toEqual({
      name: "",
      columns: [],
      rows: [],
    });
  });

  it("phase1 does not keep old rows when columns change in canvas mode", async () => {
    const tabId = "tab-swap-columns";
    let previews: Record<string, ReturnType<typeof createDefaultTablePreviewState>> = {
      [tabId]: {
        ...createDefaultTablePreviewState(),
        data: {
          name: "old_table",
          columns: ["id", "name"],
          rows: [{ id: 1, name: "a" }],
        },
        totalRows: 1,
      },
    };

    const setTablePreviews = (
      updater:
        | typeof previews
        | ((prev: typeof previews) => typeof previews),
    ) => {
      previews =
        typeof updater === "function" ? updater(previews) : updater;
    };

    const generation = bumpTablePreviewApplyGeneration(tabId);
    await applyTablePreviewDataProgressive({
      tabId,
      data: {
        name: "new_table",
        columns: ["word_meaning", "collect_time"],
        rows: [{ word_meaning: "n. postcard", collect_time: "2026-01-01" }],
      },
      totalRows: 1,
      page: 0,
      pageSize: 50,
      setTablePreviews,
      generation,
      canvasMode: true,
      chunkSize: 1,
    });

    // Phase 3 可能仍在 idle 排队；Phase 1 必须已是新列 + 空行，不能残留旧表行
    expect(previews[tabId]?.data?.columns).toEqual(["word_meaning", "collect_time"]);
    expect(previews[tabId]?.data?.rows.some((row) => "name" in row && !("word_meaning" in row))).toBe(
      false,
    );
  });

  it("beginTablePreviewFetch resets display data", () => {
    const tabId = "tab-begin";
    let previews: Record<string, ReturnType<typeof createDefaultTablePreviewState>> = {
      [tabId]: {
        ...createDefaultTablePreviewState(),
        pageSize: 100,
        data: {
          name: "t",
          columns: ["c"],
          rows: [{ c: 1 }],
        },
        totalRows: 1,
      },
    };

    const setTablePreviews = (
      updater:
        | typeof previews
        | ((prev: typeof previews) => typeof previews),
    ) => {
      previews = typeof updater === "function" ? updater(previews) : updater;
    };

    setTablePreviewRowCache(tabId, {
      name: "t",
      columns: ["c"],
      rows: [{ c: 1 }],
    });

    beginTablePreviewFetch(tabId, setTablePreviews, {
      connId: "c1",
      dbName: "db",
      tableName: "t2",
    });

    expect(previews[tabId]?.data).toBeNull();
    expect(previews[tabId]?.loading).toBe(true);
    expect(previews[tabId]?.tableName).toBe("t2");
    expect(previews[tabId]?.pageSize).toBe(100);
    expect(getTablePreviewApplyGeneration(tabId)).toBe(1);
    // 空占位而非 delete：Canvas 订阅会画空行，不会回退旧 displayRows
    expect(getTablePreviewRowCache(tabId)).toEqual({
      name: "",
      columns: [],
      rows: [],
    });
  });
});
