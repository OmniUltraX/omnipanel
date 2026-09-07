import { createTabSessionService } from "../runtime/createTabSessionService";
import type { ModuleSessionService } from "../runtime/types";
import { useDockerPanelDockStore } from "../../stores/dockerPanelDockStore";

let singleton: ModuleSessionService | null = null;

export function createDockerSessionService(): ModuleSessionService {
  if (!singleton) {
    singleton = createTabSessionService({
      listIds: () => useDockerPanelDockStore.getState().tabs.map((tab) => tab.id),
      disposeId: (id) => {
        useDockerPanelDockStore.getState().closeTab(id);
      },
    });
  }
  return singleton;
}

export function getDockerSessionService(): ModuleSessionService {
  return createDockerSessionService();
}

export function resetDockerSessionServiceForTests(): void {
  singleton = null;
}
