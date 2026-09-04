import { createTabSessionService } from "../../runtime/createTabSessionService";
import type { ModuleSessionService } from "../../runtime/types";
import { useSshPanelDockStore } from "../../../stores/sshPanelDockStore";

let singleton: ModuleSessionService | null = null;

export function createSshSessionService(): ModuleSessionService {
  if (!singleton) {
    singleton = createTabSessionService({
      listIds: () => useSshPanelDockStore.getState().tabs.map((tab) => tab.id),
      disposeId: (id) => {
        useSshPanelDockStore.getState().closeTab(id);
      },
    });
  }
  return singleton;
}

export function getSshSessionService(): ModuleSessionService {
  return createSshSessionService();
}

export function resetSshSessionServiceForTests(): void {
  singleton = null;
}
