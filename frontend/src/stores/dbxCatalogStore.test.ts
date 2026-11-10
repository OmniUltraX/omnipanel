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
  asDbxCatalogDrivers,
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
    createdAt: partial.createdAt ?? null,
    updatedAt: partial.updatedAt ?? null,
    downloads: partial.downloads ?? null,
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

  it("plugin_dbx_catalog 返回非数组（Web soft-degrade `{}`）时保持空列表", async () => {
    catalogMock.mockResolvedValueOnce({});
    await useDbxCatalogStore.getState().refresh();
    expect(useDbxCatalogStore.getState().drivers).toEqual([]);
    expect(useDbxCatalogStore.getState().refreshing).toBe(false);
  });

  it("asDbxCatalogDrivers / sameDbxCatalog 容忍非数组", () => {
    expect(asDbxCatalogDrivers({})).toEqual([]);
    expect(asDbxCatalogDrivers(undefined)).toEqual([]);
    expect(sameDbxCatalog({}, null)).toBe(true);
    expect(sameDbxCatalog([driver({ key: "hive" })], {})).toBe(false);
  });

  it("已损坏的 drivers 内存态在刷新空目录后被纠正", async () => {
    useDbxCatalogStore.setState({ drivers: { key: "bad" } as unknown as DbxCatalogDriver[] });
    catalogMock.mockResolvedValueOnce([]);
    await useDbxCatalogStore.getState().refresh();
    expect(Array.isArray(useDbxCatalogStore.getState().drivers)).toBe(true);
    expect(useDbxCatalogStore.getState().drivers).toEqual([]);
  });

  it("合法数组与空非数组都保持引用稳定，避免 selector 更新环", () => {
    const list = [driver({ key: "hive" })];
    expect(asDbxCatalogDrivers(list)).toBe(list);
    const empty: DbxCatalogDriver[] = [];
    expect(asDbxCatalogDrivers(empty)).toBe(empty);
    expect(asDbxCatalogDrivers({})).toBe(asDbxCatalogDrivers(undefined));
    expect(asDbxCatalogDrivers({})).toBe(asDbxCatalogDrivers(null));
    expect(asDbxCatalogDrivers(null)).toEqual([]);
    const mixed = [driver({ key: "oracle" }), { label: "no-key" }];
    const cleaned = asDbxCatalogDrivers(mixed);
    expect(cleaned).toHaveLength(1);
    expect(cleaned).not.toBe(mixed);
    expect(asDbxCatalogDrivers(cleaned)).toBe(cleaned);
  });
