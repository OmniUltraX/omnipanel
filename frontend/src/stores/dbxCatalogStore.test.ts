import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbxCatalogDriver } from "../ipc/bindings";

const catalogMock = vi.hoisted(() => vi.fn());

vi.mock("../ipc/bindings", () => ({
  commands: {
    pluginDbxCatalog: () => catalogMock(),
  },
}));

vi.mock("../ipc/result", () => ({
  unwrapCommand: async (promise: Promise<unknown>) => promise,
}));

import {
  resetDbxCatalogStoreForTests,
  sameDbxCatalog,
  useDbxCatalogStore,
} from "./dbxCatalogStore";

function driver(partial: Partial<DbxCatalogDriver> & Pick<DbxCatalogDriver, "key">): DbxCatalogDriver {
  return {
    pluginId: `omni.engine.${partial.key}`,
    label: partial.label ?? partial.key,
    version: "1.0.0",
    defaultPort: 0,
    size: 1,
    artifactKind: "native",
    installed: false,
    installedVersion: null,
    ...partial,
  };
}

describe("dbxCatalogStore", () => {
  beforeEach(() => {
    resetDbxCatalogStoreForTests();
    catalogMock.mockReset();
  });

  it("sameDbxCatalog 按 key / 安装态比较", () => {
    const a = [driver({ key: "hive", installed: false })];
    const b = [driver({ key: "hive", installed: false })];
    const c = [driver({ key: "hive", installed: true })];
    expect(sameDbxCatalog(a, b)).toBe(true);
    expect(sameDbxCatalog(a, c)).toBe(false);
  });

  it("刷新成功写入列表；失败时保留旧缓存", async () => {
    catalogMock.mockResolvedValueOnce([driver({ key: "oracle", label: "oracle" })]);
    await useDbxCatalogStore.getState().refresh();
    expect(useDbxCatalogStore.getState().drivers.map((d) => d.key)).toEqual(["oracle"]);

    catalogMock.mockRejectedValueOnce(new Error("network"));
    await useDbxCatalogStore.getState().refresh();
    expect(useDbxCatalogStore.getState().drivers.map((d) => d.key)).toEqual(["oracle"]);
    expect(useDbxCatalogStore.getState().refreshing).toBe(false);
  });

  it("并发 refresh 共用同一次请求", async () => {
    let resolveList: ((value: DbxCatalogDriver[]) => void) | undefined;
    catalogMock.mockImplementationOnce(
      () =>
        new Promise<DbxCatalogDriver[]>((resolve) => {
          resolveList = resolve;
        }),
    );
    const first = useDbxCatalogStore.getState().refresh();
    const second = useDbxCatalogStore.getState().refresh();
    expect(catalogMock).toHaveBeenCalledTimes(1);
    resolveList?.([driver({ key: "neo4j", label: "Neo4j" })]);
    await Promise.all([first, second]);
    expect(useDbxCatalogStore.getState().drivers[0]?.key).toBe("neo4j");
  });
});
