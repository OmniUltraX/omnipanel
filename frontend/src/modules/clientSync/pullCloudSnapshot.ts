import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useAuthStore } from "../../stores/authStore";
import { useAiStore, type AiConversation } from "../../stores/aiStore";
import { useWorkspaceStore, type WorkspaceInfo } from "../../stores/workspaceStore";
import {
  setClientConversationSyncSuppressed,
} from "./autoSync";
import { mergeConversations, parseConversationsBundle } from "./merge";
import {
  CLIENT_SYNC_MODULES_APPLIED_EVENT,
  setClientModuleSyncSuppressed,
} from "./moduleSync";
import { useClientSyncTombstoneStore } from "./tombstones";

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
  } catch {
  }
}

function applyConversationsBundle(bodyJson: string): void {
  const bundle = parseConversationsBundle(bodyJson);
  if (!bundle) return;

  const tombstoneStore = useClientSyncTombstoneStore.getState();
  if (bundle.deleted.length > 0) {
    tombstoneStore.mergeRemote("conversation", bundle.deleted);
  }

  const remote = bundle.conversations;
  if (!Array.isArray(remote) || remote.length === 0) return;

  const tombstones = tombstoneStore.listConversationTombstones();
  const local = useAiStore.getState().conversations;
  const { conversations, changed } = mergeConversations({
    local,
    remote: remote as AiConversation[],
    tombstones,
  });
  if (!changed) return;

  const active = useAiStore.getState().activeConversationId;
  const activeStill = active && conversations.some((c) => c.id === active);
  useAiStore.setState({
    conversations,
    activeConversationId: activeStill
      ? active
      : conversations.find((c) => !c.parentConversationId)?.id ?? null,
  });
}

async function refreshLocalModuleUi(): Promise<void> {
  try {
    const { useConnectionStore } = await import("../../stores/connectionStore");
    await useConnectionStore.getState().refresh();
  } catch {
  }
  try {
    const { useKnowledgeStore } = await import("../../stores/knowledgeStore");
    await useKnowledgeStore.getState().loadEntries();
  } catch {
  }
  try {
    const { reloadBootstrappedDbConnections } = await import(
      "../database/schema/initDbSchemaUiStores"
    );
    await reloadBootstrappedDbConnections();
  } catch {
  }
  window.dispatchEvent(new CustomEvent(CLIENT_SYNC_MODULES_APPLIED_EVENT));
}

/** 启动时从云端拉取账号级快照并应用到本机。 */
export async function pullCloudSnapshot(): Promise<void> {
  const token = useAuthStore.getState().token;
  if (!token?.trim()) return;

  setClientModuleSyncSuppressed(true);
  setClientConversationSyncSuppressed(true);
  try {
    const modulesResult = await unwrapCommand(
      commands.clientSyncPullModules({ token }),
      { quiet: true },
    );
    if (modulesResult.found) {
      mergeWorkspacesJson(modulesResult.workspacesJson);
      await refreshLocalModuleUi();
    }

    const convResult = await unwrapCommand(
      commands.clientSyncPullConversations({ token }),
      { quiet: true },
    );
    if (convResult.found && convResult.bodyJson?.trim()) {
      applyConversationsBundle(convResult.bodyJson);
    }
  } catch {
  } finally {
    setClientModuleSyncSuppressed(false);
    setClientConversationSyncSuppressed(false);
  }
}
