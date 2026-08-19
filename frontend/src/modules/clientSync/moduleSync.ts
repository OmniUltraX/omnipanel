import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useAuthStore } from "../../stores/authStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import { getCurrentSyncTeamId } from "../../stores/currentSyncTeamStore";
import { toIpcTombstones, useClientSyncTombstoneStore } from "./tombstones";

/** 模块同步落到本机后派发，供 Database / Protocol 等面板刷新 */
export const CLIENT_SYNC_MODULES_APPLIED_EVENT = "omnipanel:client-sync-modules-applied";

let inFlight: Promise<void> | null = null;
let pendingAfterFlight = false;
let suppressPush = false;

export function setClientModuleSyncSuppressed(value: boolean): void {
  suppressPush = value;
}

export function cancelClientModuleSync(): void {
  pendingAfterFlight = false;
}

function collectWorkspacesJson(): string {
  const list = useWorkspaceStore.getState().workspaces;
  const payload = list.map((w) => ({
    id: w.id,
    name: w.name,
    description: w.description ?? "",
    windowForm: w.windowForm ?? null,
    updatedAt: Date.now(),
  }));
  return JSON.stringify(payload);
}

function deletedPayload() {
  const store = useClientSyncTombstoneStore.getState();
  store.pruneExpired();
  return {
    deletedConnections: toIpcTombstones(store.listByKind("connection")),
    deletedDatabases: toIpcTombstones(store.listByKind("database")),
    deletedKnowledge: toIpcTombstones(store.listByKind("knowledge")),
    deletedHttpRequests: toIpcTombstones(store.listByKind("httpRequest")),
    deletedHttpCollections: toIpcTombstones(store.listByKind("httpCollection")),
    deletedHttpEnvironments: toIpcTombstones(store.listByKind("httpEnvironment")),
    deletedWorkspaces: toIpcTombstones(store.listByKind("workspace")),
  };
}

/**
 * 模块数据变更后立即推送到当前同步团队 OSS `modules/latest.json`。
 */
export function scheduleClientModuleSync(): void {
  if (suppressPush) return;
  const token = useAuthStore.getState().token;
  if (!token?.trim()) return;

  void runPush();
}

async function runPush(): Promise<void> {
  if (suppressPush) return;
  const token = useAuthStore.getState().token;
  if (!token?.trim()) return;

  if (inFlight) {
    pendingAfterFlight = true;
    return;
  }

  inFlight = (async () => {
    try {
      const deleted = deletedPayload();
      await unwrapCommand(
        commands.clientSyncPushModules({
          token,
          workspacesJson: collectWorkspacesJson(),
          teamId: getCurrentSyncTeamId(),
          ...deleted,
        }),
        { quiet: true },
      );
    } catch {
    } finally {
      inFlight = null;
      if (pendingAfterFlight) {
        pendingAfterFlight = false;
        scheduleClientModuleSync();
      }
    }
  })();

  await inFlight;
}
