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
    expect(getTablePreviewRowCache(tabId)).toBeUndefined();
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
      updater: typeof previews | ((prev: typeof previews) => typeof previews),
    ) => {
      previews = typeof updater === "function" ? updater(previews) : updater;
    };

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
  });
});
