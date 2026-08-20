import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { syncAuthProfile } from "../../lib/auth/syncAuthProfile";
import { useAuthStore } from "../../stores/authStore";
import { useAiStore, type AiConversation } from "../../stores/aiStore";
import { useUserProfileStore } from "../../stores/userProfileStore";
import { useWorkspaceStore, type WorkspaceInfo } from "../../stores/workspaceStore";
import { getCurrentSyncTeamId } from "../../stores/currentSyncTeamStore";
import {
  setClientConversationSyncSuppressed,
} from "./autoSync";
import { mergeConversations, parseConversationsBundle } from "./merge";
import {
  CLIENT_SYNC_MODULES_APPLIED_EVENT,
  setClientModuleSyncSuppressed,
} from "./moduleSync";
import {
  pullSecretsVaultOnce,
  setSecretsVaultSyncSuppressed,
} from "./secretsVaultSync";
import { CLOUD_PULL_DISABLED } from "./syncFlags";
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

/** 密文库需要 ossPath；团队校验需要 teams。缺一则先补齐 /api/me。 */
async function ensureAuthProfileForPull(): Promise<void> {
  const profile = useUserProfileStore.getState();
  const needsProfile =
    !profile.ossPath?.trim() || !Array.isArray(profile.teams) || profile.teams.length === 0;
  if (!needsProfile) return;
  await syncAuthProfile();
}

export type PullCloudSnapshotResult = {
  ok: boolean;
  modulesFound: boolean;
  conversationsFound: boolean;
  appliedConnections: number;
  appliedDatabases: number;
};

/** 启动时从当前同步团队 OSS 拉取快照并应用到本机。 */
export async function pullCloudSnapshot(): Promise<PullCloudSnapshotResult> {
  const empty: PullCloudSnapshotResult = {
    ok: false,
    modulesFound: false,
    conversationsFound: false,
    appliedConnections: 0,
    appliedDatabases: 0,
  };
  if (CLOUD_PULL_DISABLED) {
    console.warn("[client-sync] cloud pull temporarily disabled (CLOUD_PULL_DISABLED)");
    return {
      ok: true,
      modulesFound: false,
      conversationsFound: false,
      appliedConnections: 0,
      appliedDatabases: 0,
    };
  }
  const token = useAuthStore.getState().token;
  if (!token?.trim()) return empty;

  try {
    await ensureAuthProfileForPull();
  } catch (err) {
    console.warn("[client-sync] ensureAuthProfileForPull failed:", err);
  }

  const teamId = getCurrentSyncTeamId();
  setClientModuleSyncSuppressed(true);
  setClientConversationSyncSuppressed(true);
  setSecretsVaultSyncSuppressed(true);
  let modulesFound = false;
  let conversationsFound = false;
  let appliedConnections = 0;
  let appliedDatabases = 0;
  let result: PullCloudSnapshotResult = empty;
  try {
    const modulesResult = await unwrapCommand(
      commands.clientSyncPullModules({ token, teamId }),
      { quiet: true },
    );
    modulesFound = Boolean(modulesResult.found);
    appliedConnections = Number(modulesResult.appliedConnections ?? 0);
    appliedDatabases = Number(modulesResult.appliedDatabases ?? 0);
    if (modulesFound) {
      mergeWorkspacesJson(modulesResult.workspacesJson);
      await refreshLocalModuleUi();
    }

    const convResult = await unwrapCommand(
      commands.clientSyncPullConversations({ token, teamId }),
      { quiet: true },
    );
    conversationsFound = Boolean(convResult.found && convResult.bodyJson?.trim());
    if (conversationsFound && convResult.bodyJson) {
      applyConversationsBundle(convResult.bodyJson);
    }

    // 模块快照不含密码；有 SyncMasterKey 时再拉密文库。
    await pullSecretsVaultOnce();

    result = {
      ok: true,
      modulesFound,
      conversationsFound,
      appliedConnections,
      appliedDatabases,
    };
  } catch (err) {
    console.warn("[client-sync] pullCloudSnapshot failed:", err);
    result = {
      ok: false,
      modulesFound,
      conversationsFound,
      appliedConnections,
      appliedDatabases,
    };
  } finally {
    setClientModuleSyncSuppressed(false);
    setClientConversationSyncSuppressed(false);
    setSecretsVaultSyncSuppressed(false);
  }

  // suppress 解除后再考虑回写，否则 schedule 会被吞掉
  await republishLocalModulesIfCloudEmpty(result);
  return result;
}

/**
 * 拉取结束后：若云端无有效模块快照但本机有连接，回写云端（修复空设备误覆盖后的恢复）。
 */
async function republishLocalModulesIfCloudEmpty(
  pulled: PullCloudSnapshotResult,
): Promise<void> {
  if (!pulled.ok || pulled.modulesFound) return;
  try {
    const local = await unwrapCommand(commands.connList(), { quiet: true });
    if (Array.isArray(local) && local.length > 0) {
      const { scheduleClientModuleSync } = await import("./moduleSync");
      scheduleClientModuleSync();
    }
  } catch {
  }
}
