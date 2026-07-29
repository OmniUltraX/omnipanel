import { commands } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { useAuthStore } from "../../stores/authStore";
import { useWorkspaceStore, type WorkspaceInfo } from "../../stores/workspaceStore";
import { toIpcTombstones, useClientSyncTombstoneStore } from "./tombstones";

const DEBOUNCE_MS = 5000;

let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let pendingAfterFlight = false;
let suppressPush = false;

export function setClientModuleSyncSuppressed(value: boolean): void {
  suppressPush = value;
}

export function cancelClientModuleSync(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
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
 * 模块数据变更后调度推送到 `sync/{userId}/v1/modules/…`。
 */
export function scheduleClientModuleSync(options?: { immediate?: boolean }): void {
  if (suppressPush) return;
  const token = useAuthStore.getState().token;
  if (!token?.trim()) return;

  if (options?.immediate) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    void runPush();
    return;
  }

  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void runPush();
  }, DEBOUNCE_MS);
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
          ...deleted,
        }),
        { quiet: true },
      );
    } catch (err) {
      console.warn("[client-sync:modules]", formatIpcError(err));
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

function applyWorkspacesJson(raw: string | null | undefined): void {
  if (!raw?.trim()) return;
  try {
    const list = JSON.parse(raw) as Array<{
      id: string;
      name: string;
      description?: string;
      windowForm?: string | null;
    }>;
    if (!Array.isArray(list) || list.length === 0) return;
    const workspaces: WorkspaceInfo[] = list
      .filter((w) => w?.id && w?.name)
      .map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description ?? "",
        windowForm:
          w.windowForm === "windowed" || w.windowForm === "embedded"
            ? w.windowForm
            : undefined,
      }));
    if (workspaces.length === 0) return;

    const current = useWorkspaceStore.getState();
    const activeStill = workspaces.some((w) => w.id === current.workspace.id);
    useWorkspaceStore.setState({
      workspaces,
      workspace: activeStill ? current.workspace : workspaces[0],
    });
  } catch (err) {
    console.warn("[client-sync:modules] apply workspaces failed", err);
  }
}

/**
 * 登录后 pull 模块数据并应用到本机；必要时播种推送。
 */
export async function hydrateClientModuleSync(): Promise<void> {
  const token = useAuthStore.getState().token;
  if (!token?.trim()) return;

  try {
    if (useWorkspaceStore.persist?.hasHydrated && !useWorkspaceStore.persist.hasHydrated()) {
      await new Promise<void>((resolve) => {
        const unsub = useWorkspaceStore.persist.onFinishHydration(() => {
          unsub();
          resolve();
        });
      });
    }
    if (
      useClientSyncTombstoneStore.persist?.hasHydrated &&
      !useClientSyncTombstoneStore.persist.hasHydrated()
    ) {
      await new Promise<void>((resolve) => {
        const unsub = useClientSyncTombstoneStore.persist.onFinishHydration(() => {
          unsub();
          resolve();
        });
      });
    }

    setClientModuleSyncSuppressed(true);
    const deleted = deletedPayload();
    const result = await unwrapCommand(
      commands.clientSyncPullModules({
        token,
        workspacesJson: collectWorkspacesJson(),
        ...deleted,
      }),
      { quiet: true },
    );

    if (result.workspacesJson) {
      applyWorkspacesJson(result.workspacesJson);
    }

    // 刷新前端连接 / 知识缓存（后端已写入）
    void import("../../stores/connectionStore").then((m) => {
      void m.useConnectionStore.getState().refresh();
    });
    void import("../../stores/knowledgeStore").then((m) => {
      void m.useKnowledgeStore.getState().loadEntries();
    });

    setClientModuleSyncSuppressed(false);

    if (!result.found) {
      const hasLocal =
        result.connectionCount > 0 ||
        result.databaseCount > 0 ||
        result.knowledgeCount > 0 ||
        result.httpRequestCount > 0 ||
        useWorkspaceStore.getState().workspaces.length > 0;
      if (hasLocal) {
        scheduleClientModuleSync({ immediate: true });
      }
    }
    // found=true 时 pull 命令已回写云端，无需再 push
  } catch (err) {
    setClientModuleSyncSuppressed(false);
    console.warn("[client-sync:modules] hydrate failed:", formatIpcError(err));
  }
}
