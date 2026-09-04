import { describe, expect, it, afterEach } from "vitest";
import { parsePluginManifest } from "@omnipanel/plugin-sdk";
import { usePluginRuntimeStore } from "../stores/pluginRuntimeStore";
import { setInstalledPluginManifests } from "./pluginManifests";
import {
  asRecordList,
  findPanelDriver,
  getPanelDriver,
  hasInprocPanelDriver,
  injectPanelApiKey,
  normalizePanelDatabaseRow,
  registerPanelDriver,
  unregisterPanelDriver,
} from "./panelDriverRegistry";

describe("panelDriverRegistry", () => {
  it("登记与卸除 driver", () => {
    registerPanelDriver("omni.panel.test", {
      listDatabases: async () => [],
    });
    expect(findPanelDriver("omni.panel.test")?.listDatabases).toEqual(expect.any(Function));
    unregisterPanelDriver("omni.panel.test");
    expect(findPanelDriver("omni.panel.test")).toBeNull();
  });

  it("normalizePanelDatabaseRow 兼容 1Panel / 宝塔字段", () => {
    expect(
      normalizePanelDatabaseRow({
        id: 3,
        name: "blog",
        username: "blogu",
        type: "mysql",
        description: "备注",
      }),
    ).toMatchObject({
      id: 3,
      name: "blog",
      user: "blogu",
      type: "mysql",
      remark: "备注",
    });
    expect(
      normalizePanelDatabaseRow({
        id: "8",
        name: "shop",
        db_user: "shopu",
        ps: "bt",
      }),
    ).toMatchObject({
      id: 8,
      name: "shop",
      user: "shopu",
      type: "MySQL",
      remark: "bt",
    });
  });

  it("asRecordList 过滤非对象", () => {
    expect(asRecordList([{ a: 1 }, null, "x", ["y"]])).toEqual([{ a: 1 }]);
  });

  afterEach(() => {
    unregisterPanelDriver("omni.panel.acme");
    unregisterPanelDriver("omni.panel.test");
    setInstalledPluginManifests([]);
    usePluginRuntimeStore.setState({ hydrated: false, items: [] });
  });

  it("第一方无本地 driver 不走 L2", () => {
    usePluginRuntimeStore.setState({ hydrated: false, items: [] });
    expect(getPanelDriver("bt")).toBeNull();
    expect(getPanelDriver("1panel")).toBeNull();
  });

  it("第三方 L2 只挂清单 methods", () => {
    usePluginRuntimeStore.setState({ hydrated: false, items: [] });
    const driver = getPanelDriver("omni.panel.acme");
    expect(driver?.listDatabases).toEqual(expect.any(Function));
    expect(driver?.testConnection).toBeUndefined();
    expect(driver?.listWebsites).toBeUndefined();
    expect(driver?.createWebsite).toBeUndefined();

    setInstalledPluginManifests([
      parsePluginManifest({
        id: "omni.panel.acme",
        version: "0.1.0",
        kind: "panel",
        methods: [
          { name: "testConnection" },
          { name: "listDatabases" },
          { name: "listWebsites" },
          { name: "getDashboard" },
        ],
        contributes: { ui: { panelTabs: [{ id: "databases" }, { id: "websites" }, { id: "overview" }] } },
      }),
    ]);
    const declared = getPanelDriver("omni.panel.acme");
    expect(declared?.testConnection).toEqual(expect.any(Function));
    expect(declared?.listWebsites).toEqual(expect.any(Function));
    expect(declared?.getDashboard).toEqual(expect.any(Function));
    expect(declared?.listCertificates).toBeUndefined();
    expect(declared?.createWebsite).toBeUndefined();
    expect(declared?.installApp).toBeUndefined();
  });

  it("hasInprocPanelDriver 只认已登记的进程内 driver", () => {
    expect(hasInprocPanelDriver("omni.panel.acme")).toBe(false);
    registerPanelDriver("omni.panel.acme", { listDatabases: async () => [] });
    expect(hasInprocPanelDriver("omni.panel.acme")).toBe(true);
  });

  it("已有 apiKey 时不覆盖", async () => {
    const next = await injectPanelApiKey({
      address: "https://panel.example",
      apiKey: "  live-key  ",
      connectionId: "conn-1",
    });
    expect(next.apiKey).toBe("live-key");
  });

  it("无 connectionId 时不回源 Vault", async () => {
    const next = await injectPanelApiKey({
      address: "https://panel.example",
      apiKey: "",
      connectionId: "",
    });
    expect(next.apiKey).toBe("");
  });

  it("已 hydrate 且未激活的第三方返回 null", () => {
    usePluginRuntimeStore.setState({ hydrated: true, items: [] });
    expect(getPanelDriver("omni.panel.acme")).toBeNull();
  });
});
