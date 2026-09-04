import { beforeEach, describe, expect, it } from "vitest";
import { useDbWorkspaceDockTabsStore } from "../../stores/dbWorkspaceDockTabsStore";
import {
  createDatabaseSessionService,
  registerDatabaseTabCloser,
  resetDatabaseSessionServiceForTests,
} from "./databaseSessionService";
import type { DbWorkspaceTab } from "./workspace/workspaceTabs";

describe("databaseSessionService + dockTabsStore", () => {
  beforeEach(() => {
    resetDatabaseSessionServiceForTests();
  });

  it("list 反映 store 中的 Tab", () => {
    const tab = {
      id: "sql-1",
      kind: "sql",
      label: "q",
      connId: "c1",
    } as DbWorkspaceTab;
    useDbWorkspaceDockTabsStore.getState().setTabs([tab]);
    const service = createDatabaseSessionService();
    expect(service.list().map((s) => s.id)).toEqual(["sql-1"]);
  });

  it("dispose 走注册的 closer", async () => {
    const closed: string[] = [];
    registerDatabaseTabCloser((id) => {
      closed.push(id);
    });
    useDbWorkspaceDockTabsStore.getState().setTabs([
      { id: "t1", kind: "sql", label: "a", connId: "c1" } as DbWorkspaceTab,
    ]);
    const service = createDatabaseSessionService();
    await service.dispose("t1");
    expect(closed).toEqual(["t1"]);
  });
});
