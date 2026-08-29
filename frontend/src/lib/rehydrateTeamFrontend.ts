/**
 * 切换团队 persist 桶后：先重置内存到初始值，再从新桶 rehydrate。
 * zustand persist 在 storage miss 时不会清内存，必须先 reset。
 */

type PersistStore = {
  persist: { rehydrate: () => void | Promise<void> };
  setState: (state: object, replace?: boolean) => void;
  getInitialState: () => object;
};

async function resetAndRehydrate(store: PersistStore): Promise<void> {
  store.setState(store.getInitialState(), true);
  await Promise.resolve(store.persist.rehydrate());
}

function asPersistStore(value: unknown): PersistStore | null {
  if (!value || typeof value !== "object") return null;
  const store = value as Partial<PersistStore>;
  if (typeof store.persist?.rehydrate !== "function") return null;
  if (typeof store.setState !== "function") return null;
  if (typeof store.getInitialState !== "function") return null;
  return store as PersistStore;
}

const LOADERS: Array<() => Promise<unknown>> = [
  () => import("../stores/workspaceStore").then((m) => m.useWorkspaceStore),
  () => import("../stores/workspaceTabStore").then((m) => m.useWorkspaceTabStore),
  () => import("../stores/workspaceMembershipStore").then((m) => m.useWorkspaceMembershipStore),
  () => import("../stores/workspaceBottomDockStore").then((m) => m.useWorkspaceBottomDockStore),
  () => import("../modules/workspace/useDashboardStore").then((m) => m.useDashboardStore),
  () => import("../stores/aiStore").then((m) => m.useAiStore),
  () => import("../stores/loopStore").then((m) => m.useLoopStore),
  () => import("../stores/aiOrchestrationStore").then((m) => m.useAiOrchestrationStore),
  () =>
    import("./ai/uiFollow/pendingFollowIntentsStore").then((m) => m.usePendingFollowIntentsStore),
  () => import("../stores/knowledgeStore").then((m) => m.useKnowledgeStore),
  () => import("../stores/knowledgeWorkspaceStore").then((m) => m.useKnowledgeWorkspaceStore),
  () => import("../modules/clientSync/tombstones").then((m) => m.useClientSyncTombstoneStore),
  () => import("../stores/protocolWorkspaceStore").then((m) => m.useProtocolWorkspaceStore),
  () => import("../stores/protocolLabEntryStore").then((m) => m.useProtocolLabEntryStore),
  () => import("../stores/protocolHttpDockStore").then((m) => m.useProtocolHttpDockStore),
  () => import("../stores/protocolHttpLayoutStore").then((m) => m.useProtocolHttpLayoutStore),
  () => import("../stores/dbScratchQueryStore").then((m) => m.useDbScratchQueryStore),
  () => import("../stores/dbSqlFileStore").then((m) => m.useDbSqlFileStore),
  () =>
    import("../stores/dbSchemaConnectionLayoutStore").then((m) => m.useDbSchemaConnectionLayoutStore),
  () => import("../stores/dbDockLayoutStore").then((m) => m.useDbDockLayoutStore),
  () => import("../stores/sshPanelDockStore").then((m) => m.useSshPanelDockStore),
  () => import("../stores/sshDockLayoutStore").then((m) => m.useSshDockLayoutStore),
  () => import("../stores/sshSidebarTreeStore").then((m) => m.useSshSidebarTreeStore),
  () =>
    import("../modules/server/ssh/stores/sshWorkspaceNavStore").then((m) => m.useSshWorkspaceNavStore),
  () => import("../stores/dockerPanelDockStore").then((m) => m.useDockerPanelDockStore),
  () => import("../stores/dockerDockLayoutStore").then((m) => m.useDockerDockLayoutStore),
  () => import("../stores/dockerSidebarTreeStore").then((m) => m.useDockerSidebarTreeStore),
  () => import("../stores/serverPanelCacheStore").then((m) => m.useServerPanelCacheStore),
  () => import("../stores/serverPanelDockStore").then((m) => m.useServerPanelDockStore),
  () => import("../stores/serverDockLayoutStore").then((m) => m.useServerDockLayoutStore),
  () => import("../stores/serverTabStore").then((m) => m.useServerTabStore),
  () => import("../stores/serverGroupStore").then((m) => m.useServerGroupStore),
  () => import("../stores/filesWorkspaceSessionStore").then((m) => m.useFilesWorkspaceSessionStore),
  () => import("../stores/filesFavoritesStore").then((m) => m.useFilesFavoritesStore),
  () => import("../stores/terminalStore").then((m) => m.useTerminalStore),
  () => import("../modules/terminal/tmuxPaneSessionIndex").then((m) => m.useTmuxPaneSessionIndex),
  () => import("../stores/terminalDockLayoutStore").then((m) => m.useTerminalDockLayoutStore),
  () =>
    import("../modules/terminal/commandBar/sessionShellHistoryStore").then(
      (m) => m.useSessionShellHistoryStore,
    ),
  () => import("../stores/workflowStore").then((m) => m.useWorkflowStore),
  () => import("../stores/bgTaskHistoryStore").then((m) => m.useBgTaskHistoryStore),
  () => import("../modules/teamSync/exclusions").then((m) => m.useTeamSyncExclusionStore),
  () => import("../stores/bottomPanelStore").then((m) => m.useBottomPanelStore),
  () => import("../hooks/usePersistedModuleTab").then((m) => m.useModuleTabStore),
];

export async function rehydrateTeamFrontend(): Promise<void> {
  try {
    const { resetComposeFilesCacheForTeamSwitch } = await import(
      "../modules/docker/dockerComposeFilesCache"
    );
    resetComposeFilesCacheForTeamSwitch();
  } catch {
    // ignore
  }
  try {
    const { resetTableDetailsCacheForTeamSwitch } = await import(
      "../modules/database/workspace/tableDetailsCache"
    );
    resetTableDetailsCacheForTeamSwitch();
  } catch {
    // ignore
  }

  const loaded = await Promise.all(LOADERS.map((load) => load().catch(() => null)));
  await Promise.all(
    loaded.map((store) => {
      const persistStore = asPersistStore(store);
      if (!persistStore) return Promise.resolve();
      return resetAndRehydrate(persistStore).catch(() => undefined);
    }),
  );
}
