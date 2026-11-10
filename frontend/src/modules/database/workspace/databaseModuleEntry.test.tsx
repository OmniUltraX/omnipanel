import { useMemo, useRef } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { listEngineDescriptors } from "../engineRegistry";
import { buildEnginePickerItems } from "../connection/enginePicker";
import {
  asDbxCatalogDrivers,
  resetDbxCatalogStoreForTests,
  useDbxCatalogStore,
} from "../../../stores/dbxCatalogStore";

/** 浏览器验收预存：SSH/SFTP + 各第一方库。进入数据库模块时 ConnectionDialog 始终挂载。 */
const PRESAVED_CONNECTIONS = [
  { id: "ssh-gui", kind: "ssh", name: "gui-ssh" },
  { id: "sftp-gui", kind: "file", name: "gui-sftp", protocol: "sftp" },
  { id: "mysql-gui", kind: "database", name: "gui-mysql", engine: "mysql" },
  { id: "postgres-gui", kind: "database", name: "gui-postgres", engine: "postgresql" },
  { id: "redis-gui", kind: "database", name: "gui-redis", engine: "redis" },
  { id: "mongo-gui", kind: "database", name: "gui-mongo", engine: "mongodb" },
  { id: "clickhouse-gui", kind: "database", name: "gui-clickhouse", engine: "clickhouse" },
  { id: "sqlite-gui", kind: "database", name: "gui-sqlite", engine: "sqlite" },
] as const;

const FIRST_PARTY_IDS = ["mysql", "postgresql", "sqlite", "redis", "mongodb", "clickhouse"] as const;
const UPDATE_DEPTH_LIMIT = 30;

function enterDatabaseModule(catalog: unknown) {
  const connections = PRESAVED_CONNECTIONS.filter((item) => item.kind === "database");
  const pickerItems = buildEnginePickerItems(listEngineDescriptors(), catalog);
  return { connections, pickerItems };
}

/**
 * 复现进入数据库模块时 ConnectionDialog 的 Zustand selector 路径。
 * 若 `asDbxCatalogDrivers` 每次返回新数组，React 会 Maximum update depth exceeded（#185）。
 */
function DatabaseModuleEntrySurface({
  selector,
}: {
  selector: (state: { drivers: unknown }) => unknown;
}) {
  const renders = useRef(0);
  renders.current += 1;
  if (renders.current > UPDATE_DEPTH_LIMIT) {
    throw new Error("Maximum update depth exceeded");
  }
  const catalog = useDbxCatalogStore(selector as never);
  const pickerItems = useMemo(
    () => buildEnginePickerItems(listEngineDescriptors(), catalog),
    [catalog],
  );
  const connections = PRESAVED_CONNECTIONS.filter((item) => item.kind === "database");
  return (
    <div>
      <span data-testid="render-count">{renders.current}</span>
      <span data-testid="connection-ids">{connections.map((item) => item.id).join(",")}</span>
      <span data-testid="engine-ids">{pickerItems.map((item) => item.id).join(",")}</span>
    </div>
  );
}

describe("进入数据库模块（多连接预存 + 非数组 catalog）", () => {
  it("第一方引擎描述符齐全", () => {
    const ids = listEngineDescriptors().map((item) => item.id);
    for (const id of FIRST_PARTY_IDS) {
      expect(ids).toContain(id);
    }
  });

  it.each([undefined, null, {}, { drivers: [] }, { length: 2 }, "not-a-list", 0] as const)(
    "catalog=%s 时进入模块不抛，预存库连接仍可见，第一方引擎可选",
    (catalog) => {
      const { connections, pickerItems } = enterDatabaseModule(catalog);
      expect(connections.map((item) => item.engine)).toEqual([
        "mysql",
        "postgresql",
        "redis",
        "mongodb",
        "clickhouse",
        "sqlite",
      ]);
      expect(connections).toHaveLength(6);
      const ids = pickerItems.map((item) => item.id);
      for (const id of FIRST_PARTY_IDS) {
        expect(ids).toContain(id);
        expect(pickerItems.find((item) => item.id === id)?.available).toBe(true);
      }
    },
  );

  it("内存态被写成 soft-degrade 对象后，选择器仍可构建", () => {
    resetDbxCatalogStoreForTests();
    useDbxCatalogStore.setState({
      drivers: {} as never,
    });
    const catalog = asDbxCatalogDrivers(useDbxCatalogStore.getState().drivers);
    const { pickerItems } = enterDatabaseModule(useDbxCatalogStore.getState().drivers);
    expect(catalog).toEqual([]);
    expect(pickerItems.find((item) => item.id === "sqlite")?.available).toBe(true);
    resetDbxCatalogStoreForTests();
  });
});

describe("进入数据库模块不会陷入 setState 更新环（React #185）", () => {
  const selectors = {
    "asDbxCatalogDrivers(s.drivers)": (s: { drivers: unknown }) => asDbxCatalogDrivers(s.drivers),
    "s.drivers": (s: { drivers: unknown }) => s.drivers,
  } as const;

  it.each([
    ["空数组", () => {
      resetDbxCatalogStoreForTests();
      useDbxCatalogStore.setState({ drivers: [] });
    }],
    ["soft-degrade 对象", () => {
      resetDbxCatalogStoreForTests();
      useDbxCatalogStore.setState({ drivers: {} as never });
    }],
    ["已装目录项", () => {
      resetDbxCatalogStoreForTests();
      useDbxCatalogStore.setState({
        drivers: [
          {
            key: "oracle",
            pluginId: "omni.engine.oracle",
            label: "oracle",
            version: "1.0.0",
            defaultPort: 0,
            size: 1,
            artifactKind: "native",
            installed: true,
            installedVersion: "1.0.0",
            createdAt: null,
            updatedAt: null,
            downloads: null,
          },
        ],
      });
    }],
  ] as const)("%s 时两种 catalog selector 渲染次数都稳定，预存连接与第一方引擎可见", (stateLabel, setup) => {
    for (const [selectorLabel, selector] of Object.entries(selectors)) {
      setup();
      const view = render(
        <DatabaseModuleEntrySurface selector={selector} />,
      );
      const count = Number(screen.getByTestId("render-count").textContent);
      expect(count, `${stateLabel} ${selectorLabel}`).toBeGreaterThan(0);
      expect(count, `${stateLabel} ${selectorLabel}`).toBeLessThan(UPDATE_DEPTH_LIMIT);
      expect(screen.getByTestId("connection-ids").textContent).toBe(
        "mysql-gui,postgres-gui,redis-gui,mongo-gui,clickhouse-gui,sqlite-gui",
      );
      const ids = screen.getByTestId("engine-ids").textContent ?? "";
      for (const id of FIRST_PARTY_IDS) {
        expect(ids, `${stateLabel} ${selectorLabel}`).toContain(id);
      }
      view.unmount();
    }
  });
});
