import { useDbWorkspaceDockTabsStore } from "../../stores/dbWorkspaceDockTabsStore";
import { createTabSessionService } from "../runtime/createTabSessionService";
import type { ModuleSessionService } from "../runtime/types";

let singleton: ModuleSessionService | null = null;

/** Panel 挂载时注册：真正关 Tab 的清理（含 persist / dirty 等） */
let closeTabHandler: ((id: string) => void | Promise<void>) | null = null;

export function registerDatabaseTabCloser(
  handler: ((id: string) => void | Promise<void>) | null,
): void {
  closeTabHandler = handler;
}

/**
 * 数据库 Dock Tab Session：list/dispose 读 store；踢出模块不 dispose（与 pin/镜像一致）。
 */
export function createDatabaseSessionService(): ModuleSessionService {
  if (!singleton) {
    singleton = createTabSessionService({
      listIds: () => useDbWorkspaceDockTabsStore.getState().tabs.map((tab) => tab.id),
      disposeId: async (id) => {
        if (closeTabHandler) {
          await closeTabHandler(id);
          return;
        }
        useDbWorkspaceDockTabsStore.getState().setTabs((prev) => prev.filter((t) => t.id !== id));
      },
    });
  }
  return singleton;
}

export function getDatabaseSessionService(): ModuleSessionService {
  return createDatabaseSessionService();
}

export function resetDatabaseSessionServiceForTests(): void {
  singleton = null;
  closeTabHandler = null;
  useDbWorkspaceDockTabsStore.getState().reset();
}
