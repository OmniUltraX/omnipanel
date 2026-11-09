import { describe, it, expect } from "vitest";

describe("Database Tab Dirty State Logic", () => {
  it("should detect table preview dirty when tabDirtyRows has entries", () => {
    const tabDirtyRows: Record<string, Record<string, Record<string, unknown>>> = {
      "table-tab-1": {
        "row-1": { name: "updated" },
        "row-2": { age: 30 },
      },
    };

    const tabId = "table-tab-1";
    const dirtyRows = tabDirtyRows[tabId];
    const isDirty = dirtyRows ? Object.keys(dirtyRows).length > 0 : false;

    expect(isDirty).toBe(true);
  });

  it("should not be dirty when tabDirtyRows is empty", () => {
    const tabDirtyRows: Record<string, Record<string, Record<string, unknown>>> = {
      "table-tab-1": {},
    };

    const tabId = "table-tab-1";
    const dirtyRows = tabDirtyRows[tabId];
    const isDirty = dirtyRows ? Object.keys(dirtyRows).length > 0 : false;

    expect(isDirty).toBe(false);
  });

  it("should not be dirty when tab is not in tabDirtyRows", () => {
    const tabDirtyRows: Record<string, Record<string, Record<string, unknown>>> = {};

    const tabId = "table-tab-1";
    const dirtyRows = tabDirtyRows[tabId];
    const isDirty = dirtyRows ? Object.keys(dirtyRows).length > 0 : false;

    expect(isDirty).toBe(false);
  });

  it("should detect SQL tab dirty from dirtySqlWorkspaceTabIds set", () => {
    const dirtySqlWorkspaceTabIds = new Set(["sql-tab-1", "sql-tab-2"]);

    expect(dirtySqlWorkspaceTabIds.has("sql-tab-1")).toBe(true);
    expect(dirtySqlWorkspaceTabIds.has("sql-tab-3")).toBe(false);
  });

  it("should track dirty row count changes for selector", () => {
    const workspaceTabs = [
      { id: "table-1", kind: "table" as const },
      { id: "table-2", kind: "table" as const },
      { id: "sql-1", kind: "sql" as const },
    ];

    const tabDirtyRows: Record<string, Record<string, Record<string, unknown>>> = {
      "table-1": { "row-1": {}, "row-2": {} },
      "table-2": {},
    };

    const parts: string[] = [];
    for (const tab of workspaceTabs) {
      if (tab.kind !== "table") continue;
      const dirtyRows = tabDirtyRows[tab.id];
      const rowCount = dirtyRows ? Object.keys(dirtyRows).length : 0;
      if (rowCount > 0) parts.push(`${tab.id}:${rowCount}`);
    }
    const key = parts.join(",");

    expect(key).toBe("table-1:2");
  });
});
