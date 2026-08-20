import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { useAuthStore } from "../../stores/authStore";
import { useAiStore, type AiConversation } from "../../stores/aiStore";
import { useWorkspaceStore, type WorkspaceInfo } from "../../stores/workspaceStore";
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

export interface SwitchSyncTeamResult {
  /** 是否真正切换了团队（同团队重复点击为 false） */
  switched: boolean;
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
 * 2. 写入新 teamId，清空本团队无关的 tombstone
 * 3. 从新团队拉取快照并替换本机（有快照则整表替换；无快照则保留本机以便首次播种）
 */
export async function switchSyncTeam(
  teamId: number,
): Promise<SwitchSyncTeamResult> {
  const empty: SwitchSyncTeamResult = {
    switched: false,
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

    // 2) 切换指针；tombstone 按团队语义隔离，避免旧删除标记误伤新团队资源
    useCurrentSyncTeamStore.getState().setTeamId(teamId);
    useClientSyncTombstoneStore.getState().clearAll();

    // 临时关闭云端拉取时：只切团队指针，不拉快照覆盖本机
    if (CLOUD_PULL_DISABLED) {
      console.warn("[client-sync] switchSyncTeam pull skipped (CLOUD_PULL_DISABLED)");
      return {
        switched: true,
        pulledModules: false,
        pulledConversations: false,
      };
    }

    // 3) 拉取并替换为目标数据源
    let pulledModules = false;
    let pulledConversations = false;

    const modulesResult = await unwrapCommand(
      commands.clientSyncPullModules({ token, teamId }),
      { quiet: true },
    );
    if (modulesResult.found) {
      // 后端 apply 已按快照整表替换连接/库/知识库/HTTP；前端补工作区与 UI 刷新
      replaceWorkspacesJson(modulesResult.workspacesJson);
      await refreshLocalModuleUi();
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

    return {
      switched: true,
      pulledModules,
      pulledConversations,
    };
  } finally {
    setClientModuleSyncSuppressed(false);
    setClientConversationSyncSuppressed(false);
  }
}
