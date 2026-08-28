import { applyLocalTeamScope } from "../../lib/applyLocalTeamScope";
import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useAuthStore } from "../../stores/authStore";
import { useAiStore, type AiConversation } from "../../stores/aiStore";
import { useWorkspaceStore, type WorkspaceInfo } from "../../stores/workspaceStore";
import { applySshSidebarTreeJson } from "../../stores/sshSidebarTreeStore";
import { applyFolderTreesJson } from "./folderTrees";
import { applyCustomPanelsJson } from "../workspace/useDashboardStore";
import {
  getCurrentSyncTeamId,
  useCurrentSyncTeamStore,
} from "../../stores/currentSyncTeamStore";
import {
  flushClientConversationSync,
  setClientConversationSyncSuppressed,
} from "./autoSync";
import { mergeConversations, parseConversationsBundle } from "./merge";
import {
  CLIENT_SYNC_MODULES_APPLIED_EVENT,
  flushClientModuleSync,
  setClientModuleSyncSuppressed,
} from "./moduleSync";
import { CLOUD_PULL_DISABLED } from "./syncFlags";
import { useClientSyncTombstoneStore } from "./tombstones";
import {
  ensureTeamSyncKeyForTeam,
  setSkipPullAfterTeamKey,
  TeamSyncKeyRequiredError,
} from "../../lib/auth/ensureTeamSyncKey";
import { useSyncDeviceAuthStore } from "../../stores/syncDeviceAuthStore";
import { startTeamMesh } from "../../lib/auth/teamMesh";

export { TeamSyncKeyRequiredError };

export interface SwitchSyncTeamResult {
  /** 是否真正切换了团队（同团队重复点击为 false） */
  switched: boolean;
  /** 目标团队是否已具备本机同步密钥 */
  keyReady: boolean;
  /** 目标团队是否存在模块快照并已替换到本机 */
  pulledModules: boolean;
  /** 目标团队是否存在会话快照并已替换到本机 */
  pulledConversations: boolean;
}

function parseWorkspaceList(raw: string | null | undefined): WorkspaceInfo[] {
  if (!raw?.trim()) return [];
  try {
    const list = JSON.parse(raw) as Array<{
      id: string;
      name: string;
      description?: string;
      windowForm?: string | null;
    }>;
    if (!Array.isArray(list)) return [];
    return list
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
  } catch {
    return [];
  }
}

/** 用远端工作区列表整表替换本机（切换团队用；启动 hydrate 仍走 merge）。 */
function replaceWorkspacesJson(raw: string | null | undefined): void {
  const incoming = parseWorkspaceList(raw);
  if (incoming.length === 0) return;
  const current = useWorkspaceStore.getState();
  const activeStill = incoming.some((w) => w.id === current.workspace.id);
  useWorkspaceStore.setState({
    workspaces: incoming,
    workspace: activeStill ? current.workspace : incoming[0],
  });
}

/** 用远端会话快照整表替换本机（以 remote 为准，local 置空再 merge 以复用 tombstone 逻辑）。 */
function replaceConversationsBundle(bodyJson: string): void {
  const bundle = parseConversationsBundle(bodyJson);
  if (!bundle) return;

  const tombstoneStore = useClientSyncTombstoneStore.getState();
  if (bundle.deleted.length > 0) {
    tombstoneStore.mergeRemote("conversation", bundle.deleted);
  }

  const remote = bundle.conversations;
  if (!Array.isArray(remote)) return;

  const tombstones = tombstoneStore.listConversationTombstones();
  const { conversations } = mergeConversations({
    local: [],
    remote: remote as AiConversation[],
    tombstones,
  });

  useAiStore.setState({
    conversations,
    activeConversationId:
      conversations.find((c) => !c.parentConversationId)?.id ?? null,
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

/**
 * 切换数据快照来源团队：
 * 1. 把本机当前数据推回旧团队（避免丢失）
 * 2. 进程内换到新团队本地库，并按 teamId 换 persist 桶
 * 3. 确保目标团队同步密钥
 * 4. 仅当目标本机目录原先为空时拉取云端快照（本机已有数据以本机为准）
 */
export async function switchSyncTeam(
  teamId: number,
): Promise<SwitchSyncTeamResult> {
  const empty: SwitchSyncTeamResult = {
    switched: false,
    keyReady: false,
    pulledModules: false,
    pulledConversations: false,
  };
  if (!Number.isFinite(teamId) || teamId <= 0) return empty;

  const token = useAuthStore.getState().token;
  if (!token?.trim()) return empty;

  const prevTeamId = getCurrentSyncTeamId();
  if (prevTeamId === teamId) return empty;

  setClientModuleSyncSuppressed(true);
  setClientConversationSyncSuppressed(true);
  try {
    // 1) 先把当前数据源写回旧团队
    if (prevTeamId && prevTeamId > 0) {
      await flushClientModuleSync(prevTeamId);
      await flushClientConversationSync(prevTeamId);
    }

    // 2) 换本机目录 + persist 桶；tombstone 已按团队分桶，随 rehydrate 加载
    const switched = await applyLocalTeamScope(String(teamId));
    useCurrentSyncTeamStore.getState().setTeamId(teamId);
    useSyncDeviceAuthStore.getState().clearDismissed();

    // 换网后再传钥：旧团队节点先掉，再加入新团队 mesh
    await startTeamMesh();

    // 3) 确保目标团队同步密钥：先 mesh TCP，失败再 HTTP 中继，再失败则强制引导导入
    setSkipPullAfterTeamKey(true);
    let keyReady = false;
    try {
      keyReady = await ensureTeamSyncKeyForTeam(teamId, {
        force: true,
        relayTimeoutMs: 60_000,
      });
    } finally {
      setSkipPullAfterTeamKey(false);
    }
    if (!keyReady) {
      throw new TeamSyncKeyRequiredError();
    }

    // 临时关闭云端拉取时：只切本地库与 persist，不拉快照覆盖本机
    if (CLOUD_PULL_DISABLED) {
      console.warn("[client-sync] switchSyncTeam pull skipped (CLOUD_PULL_DISABLED)");
      await refreshLocalModuleUi();
      return {
        switched: true,
        keyReady: true,
        pulledModules: false,
        pulledConversations: false,
      };
    }

    // 4) 仅空目录才拉云端；本机已有该团队数据则以本机为准
    let pulledModules = false;
    let pulledConversations = false;

    if (switched.empty) {
      const modulesResult = await unwrapCommand(
        commands.clientSyncPullModules({ token, teamId }),
        { quiet: true },
      );
      if (modulesResult.found) {
        replaceWorkspacesJson(modulesResult.workspacesJson);
        applySshSidebarTreeJson(modulesResult.sshSidebarTreeJson, "replace");
        applyFolderTreesJson(modulesResult.folderTreesJson, "replace");
        applyCustomPanelsJson(modulesResult.customPanelsJson, "replace");
        pulledModules = true;
      }

      const convResult = await unwrapCommand(
        commands.clientSyncPullConversations({ token, teamId }),
        { quiet: true },
      );
      if (convResult.found && convResult.bodyJson?.trim()) {
        replaceConversationsBundle(convResult.bodyJson);
        pulledConversations = true;
      }
    }

    await refreshLocalModuleUi();

    return {
      switched: true,
      keyReady: true,
      pulledModules,
      pulledConversations,
    };
  } finally {
    setClientModuleSyncSuppressed(false);
    setClientConversationSyncSuppressed(false);
  }
}
