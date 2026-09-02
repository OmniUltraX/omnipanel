import { describe, expect, it } from "vitest";
import {
  asRecordList,
  findPanelDriver,
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
});
