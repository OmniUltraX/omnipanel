import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { syncAuthProfile } from "../../lib/auth/syncAuthProfile";
import { runDeviceTagMigration } from "../../lib/deviceTagMigration";
import { useAuthStore } from "../../stores/authStore";
import { useAiStore, type AiConversation } from "../../stores/aiStore";
import { useUserProfileStore } from "../../stores/userProfileStore";
import { useWorkspaceStore, type WorkspaceInfo } from "../../stores/workspaceStore";
import { uniqueTags } from "../../lib/resourceTags";
import { applySshSidebarTreeJson } from "../../stores/sshSidebarTreeStore";
import { applyFolderTreesJson } from "./folderTrees";
import { applyCustomPanelsJson } from "../workspace/useDashboardStore";
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
import { waitLayoutStoresHydrated } from "./layoutStoresHydration";
import { useClientSyncTombstoneStore } from "./tombstones";

function sidebarFoldersEmpty(raw: string | null | undefined): boolean {
  if (!raw?.trim()) return true;
  try {
    const parsed = JSON.parse(raw) as { folders?: unknown };
    return !Array.isArray(parsed.folders) || parsed.folders.length === 0;
  } catch {
    return true;
  }
}

function folderTreesAllEmpty(raw: string | null | undefined): boolean {
  if (!raw?.trim()) return true;
  try {
    const parsed = JSON.parse(raw) as Record<string, { folders?: unknown } | undefined>;
    if (!parsed || typeof parsed !== "object") return true;
    for (const key of ["docker", "database", "protocol"] as const) {
      const node = parsed[key];
      if (node && Array.isArray(node.folders) && node.folders.length > 0) {
        return false;
      }
    }
    return true;
  } catch {
    return true;
  }
}

/** 本机侧栏仍有文件夹，但云端快照布局为空 → 需要回写修复。 */
async function shouldHealEmptyCloudLayouts(
  sshSidebarTreeJson: string | null | undefined,
  folderTreesJson: string | null | undefined,
): Promise<boolean> {
  const [
    { useSshSidebarTreeStore },
    { useDockerSidebarTreeStore },
    { useDbSchemaConnectionLayoutStore },
    { useProtocolHttpLayoutStore },
  ] = await Promise.all([
    import("../../stores/sshSidebarTreeStore"),
    import("../../stores/dockerSidebarTreeStore"),
    import("../../stores/dbSchemaConnectionLayoutStore"),
    import("../../stores/protocolHttpLayoutStore"),
  ]);
  if (
    sidebarFoldersEmpty(sshSidebarTreeJson) &&
    useSshSidebarTreeStore.getState().folders.length > 0
  ) {
    return true;
  }
  if (
    folderTreesAllEmpty(folderTreesJson) &&
    (useDockerSidebarTreeStore.getState().folders.length > 0 ||
      useDbSchemaConnectionLayoutStore.getState().folders.length > 0 ||
      useProtocolHttpLayoutStore.getState().folders.length > 0)
  ) {
    return true;
  }
  return false;
}

function mergeWorkspacesJson(raw: string | null | undefined): void {
  if (!raw?.trim()) return;
  try {
    const list = JSON.parse(raw) as Array<{
      id: string;
      name: string;
      description?: string;
      windowForm?: string | null;
      tags?: string[];
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
        // 保留远端 creator 标签，避免下次上传丢失来源设备信息
        tags: Array.isArray(w.tags)
          ? uniqueTags(w.tags.filter((t) => typeof t === "string"))
          : undefined,
      }));
    if (incoming.length === 0) return;

    const current = useWorkspaceStore.getState();
    const byId = new Map(current.workspaces.map((w) => [w.id, w]));
    for (const w of incoming) {
      const existing = byId.get(w.id);
      // 名称/备注为设备本地字段，不参与云端同步：本地已有工作区保留本地名称/备注
      byId.set(
        w.id,
        existing ? { ...w, name: existing.name, description: existing.description } : w,
      );
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

  // 先等侧栏 persist 水合，再拉云端：否则 apply 后会被迟到的 IndexedDB rehydrate 盖成空 folders，
  // 随后 deviceTagMigration / 自动推送还会把空布局写回 OSS。
  try {
    await waitLayoutStoresHydrated();
  } catch (err) {
    console.warn("[client-sync] waitLayoutStoresHydrated failed:", err);
  }

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
  let healEmptyLayouts = false;
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
      applySshSidebarTreeJson(modulesResult.sshSidebarTreeJson, "merge");
      applyFolderTreesJson(modulesResult.folderTreesJson, "merge");
      applyCustomPanelsJson(modulesResult.customPanelsJson, "merge");
      await refreshLocalModuleUi();
      // merge 可能保留本机文件夹；云端布局为空时回写修复历史空快照
      healEmptyLayouts = await shouldHealEmptyCloudLayouts(
        modulesResult.sshSidebarTreeJson,
        modulesResult.folderTreesJson,
      );
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

  // 拉取结束后迁移设备标签（清掉旧设备名标签并补 creator），再考虑回写，保证推送的是干净标签
  await runDeviceTagMigration();
  // suppress 解除后再考虑回写，否则 schedule 会被吞掉
  await republishLocalModulesIfCloudEmpty(result);
  if (result.ok && healEmptyLayouts) {
    try {
      const { scheduleClientModuleSync } = await import("./moduleSync");
      scheduleClientModuleSync();
    } catch {
      // ignore
    }
  }
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
