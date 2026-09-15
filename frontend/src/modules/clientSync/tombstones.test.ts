import { describe, expect, it, beforeEach } from "vitest";
import { useClientSyncTombstoneStore } from "./tombstones";

describe("墓碑 clearByIdPrefix（思源重建用）", () => {
  beforeEach(() => {
    useClientSyncTombstoneStore.getState().clearAll();
  });

  it("只清指定前缀，不过界", () => {
    const store = useClientSyncTombstoneStore.getState();
    store.markDeleted("knowledge", ["siyuan-doc-a", "siyuan-box-b"]);
    store.markDeleted("knowledge", ["other-doc"]);
    store.markDeleted("connection", ["siyuan-conn"]);
    useClientSyncTombstoneStore.getState().clearByIdPrefix("knowledge", "siyuan-");
    const remaining = useClientSyncTombstoneStore.getState().listByKind("knowledge");
    expect(remaining.map((t) => t.id)).toEqual(["other-doc"]);
    expect(
      useClientSyncTombstoneStore.getState().listByKind("connection").map((t) => t.id),
    ).toEqual(["siyuan-conn"]);
  });

  it("空前缀不做任何事", () => {
    const store = useClientSyncTombstoneStore.getState();
    store.markDeleted("knowledge", ["siyuan-doc-a"]);
    useClientSyncTombstoneStore.getState().clearByIdPrefix("knowledge", "");
    expect(useClientSyncTombstoneStore.getState().listByKind("knowledge")).toHaveLength(1);
  });
});
