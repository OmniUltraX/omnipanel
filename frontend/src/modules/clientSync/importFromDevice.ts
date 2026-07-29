import type {
  ClientSyncImportResult,
  ClientSyncImportSelection,
  ClientSyncPeekResult,
} from "../../ipc/bindings";
import { commands } from "../../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../../ipc/result";
import { useAuthStore } from "../../stores/authStore";
import { useAiStore, type AiConversation } from "../../stores/aiStore";
import { useWorkspaceStore, type WorkspaceInfo } from "../../stores/workspaceStore";
import {
  scheduleClientConversationSync,
  setClientConversationSyncSuppressed,
} from "./autoSync";
import { mergeConversations } from "./merge";
import {
  CLIENT_SYNC_MODULES_APPLIED_EVENT,
  scheduleClientModuleSync,
  setClientModuleSyncSuppressed,
} from "./moduleSync";
import { useClientSyncTombstoneStore } from "./tombstones";

export type { ClientSyncImportSelection, ClientSyncPeekResult };

/** 预览其它设备可同步条目。 */
export async function peekDeviceSync(deviceId: string): Promise<ClientSyncPeekResult> {
  const token = useAuthStore.getState().token;
  if (!token?.trim()) {
    throw new Error("未登录");
  }
  return unwrapCommand(
    commands.clientSyncPeekDevice({ token, deviceId }),
    { logLabel: "[client-sync:peek]" },
  );
}

function mergeWorkspacesJson(raw: string | null | undefined): void {
  if (!raw?.trim()) return;
  try {
    const list = JSON.parse(raw) as Array<{
      id: string;
      name: string;
      description?: string;
      windowForm?: string | null;
    }>;
    if (!Array.isArray(list) || list.length === 0) return;

    const incoming: WorkspaceInfo[] = list
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
    if (incoming.length === 0) return;

    const current = useWorkspaceStore.getState();
    const byId = new Map(current.workspaces.map((w) => [w.id, w]));
    for (const w of incoming) {
      byId.set(w.id, w);
    }
    const workspaces = [...byId.values()];
    const activeStill = workspaces.some((w) => w.id === current.workspace.id);
    useWorkspaceStore.setState({
      workspaces,
      workspace: activeStill ? current.workspace : workspaces[0],
    });
  } catch (err) {
    console.warn("[client-sync] merge workspaces failed", err);
  }
}

function applyConversationsJson(raw: string | null | undefined): void {
  if (!raw?.trim()) return;
  try {
    const remote = JSON.parse(raw) as AiConversation[];
    if (!Array.isArray(remote) || remote.length === 0) return;

    const tombstones = useClientSyncTombstoneStore.getState().listConversationTombstones();
    const local = useAiStore.getState().conversations;
    const { conversations, changed } = mergeConversations({
      local,
      remote,
      tombstones,
    });
    if (!changed) return;

    setClientConversationSyncSuppressed(true);
    try {
      const active = useAiStore.getState().activeConversationId;
      const activeStill = active && conversations.some((c) => c.id === active);
      useAiStore.setState({
        conversations,
        activeConversationId: activeStill
          ? active
          : conversations.find((c) => !c.parentConversationId)?.id ?? null,
      });
    } finally {
      setClientConversationSyncSuppressed(false);
    }
  } catch (err) {
    console.warn("[client-sync] merge conversations failed", err);
  }
}

async function refreshLocalModuleUi(): Promise<void> {
  try {
    const { useConnectionStore } = await import("../../stores/connectionStore");
    await useConnectionStore.getState().refresh();
  } catch (err) {
    console.warn("[client-sync] refresh connections failed", err);
  }
  try {
    const { useKnowledgeStore } = await import("../../stores/knowledgeStore");
    await useKnowledgeStore.getState().loadEntries();
  } catch (err) {
    console.warn("[client-sync] refresh knowledge failed", err);
  }
  try {
    const { reloadBootstrappedDbConnections } = await import(
      "../database/schema/initDbSchemaUiStores"
    );
    await reloadBootstrappedDbConnections();
  } catch (err) {
    console.warn("[client-sync] refresh database list failed", err);
  }
  window.dispatchEvent(new CustomEvent(CLIENT_SYNC_MODULES_APPLIED_EVENT));
}

/** 从其它设备导入勾选数据，并刷新本机 UI。 */
export async function importFromDevice(
  deviceId: string,
  selection: ClientSyncImportSelection,
): Promise<ClientSyncImportResult> {
  const token = useAuthStore.getState().token;
  if (!token?.trim()) {
    throw new Error("未登录");
  }

  setClientModuleSyncSuppressed(true);
  setClientConversationSyncSuppressed(true);
  try {
    const result = await unwrapCommand(
      commands.clientSyncImportFromDevice({
        token,
        deviceId,
        selection,
      }),
      { logLabel: "[client-sync:import]" },
    );

    mergeWorkspacesJson(result.workspacesJson);
    applyConversationsJson(result.conversationsJson);
    await refreshLocalModuleUi();

    return result;
  } catch (err) {
    throw new Error(formatIpcError(err));
  } finally {
    setClientModuleSyncSuppressed(false);
    setClientConversationSyncSuppressed(false);
    // 导入后回推本机快照，供其它端后续手动拉取
    scheduleClientModuleSync({ immediate: true });
    scheduleClientConversationSync({ immediate: true });
  }
}

export function emptyImportSelection(): ClientSyncImportSelection {
  return {
    connectionIds: [],
    databaseIds: [],
    knowledgeIds: [],
    httpRequestIds: [],
    httpCollectionIds: [],
    workspaceIds: [],
    conversationIds: [],
  };
}

export function selectionCount(sel: ClientSyncImportSelection): number {
  return (
    sel.connectionIds.length +
    sel.databaseIds.length +
    sel.knowledgeIds.length +
    sel.httpRequestIds.length +
    sel.httpCollectionIds.length +
    sel.workspaceIds.length +
    sel.conversationIds.length
  );
}
