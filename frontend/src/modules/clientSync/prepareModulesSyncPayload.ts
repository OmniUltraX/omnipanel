import { useConnectionStore } from "../../stores/connectionStore";
import { useDockerSidebarTreeStore } from "../../stores/dockerSidebarTreeStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
  serializeSshSidebarTree,
  useSshSidebarTreeStore,
} from "../../stores/sshSidebarTreeStore";
import { collectFolderTreesJson } from "./folderTrees";
import { waitLayoutStoresHydrated } from "./layoutStoresHydration";
import { toIpcTombstones, useClientSyncTombstoneStore } from "./tombstones";
import { serializeCustomPanelsJson } from "../workspace/useDashboardStore";
import { uniqueTags } from "../../lib/resourceTags";
import { useAiStore } from "../../stores/aiStore";
import { useSettingsStore } from "../../stores/settingsStore";

/** 上传前对齐各模块侧栏布局与本机连接列表，避免快照与 UI 不一致。 */
export function prepareLayoutStoresForModuleSync(): void {
  const connections = useConnectionStore.getState().connections;
  // 连接尚未从后端 refresh 时勿 prune：空列表会清掉 connectionFolderId，上传后文件夹变空壳。
  if (!useConnectionStore.getState().loaded) {
    return;
  }
  const sshIds = connections.filter((c) => c.kind === "ssh").map((c) => c.id);
  const dockerIds = connections.filter((c) => c.kind === "docker").map((c) => c.id);

  const sshStore = useSshSidebarTreeStore.getState();
  sshStore.pruneMissingConnections(sshIds);
  for (const id of sshIds) {
    sshStore.ensureConnectionListed(id);
  }

  useDockerSidebarTreeStore.getState().pruneMissingConnections(dockerIds);
}

function collectWorkspacesJson(): string {
  const list = useWorkspaceStore.getState().workspaces;
  const payload = list.map((w) => ({
    id: w.id,
    name: w.name,
    description: w.description ?? "",
    windowForm: w.windowForm ?? null,
    updatedAt: Date.now(),
    tags: uniqueTags(w.tags),
  }));
  return JSON.stringify(payload);
}

/**
 * 会话还没从本机存储恢复时返回 null，避免用空列表把云端会话清掉。
 * 恢复之后返回全部会话，不再裁成 80 条或每条 120 条消息。
 */
export function collectConversationsJson(): string | null {
  if (!useAiStore.persist.hasHydrated()) return null;
  return JSON.stringify(useAiStore.getState().conversations ?? []);
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
    deletedCustomPanels: toIpcTombstones(store.listByKind("customPanel")),
  };
}

/**
 * 组装模块快照上传请求体（团队手动上传与自动推送共用）。
 * 会先等待侧栏 persist 水合、再修剪布局并序列化，避免把空 folders 推上云端。
 */
export async function collectModulesSyncPayload() {
  await waitLayoutStoresHydrated();
  prepareLayoutStoresForModuleSync();
  return {
    workspacesJson: collectWorkspacesJson(),
    sshSidebarTreeJson: serializeSshSidebarTree(),
    folderTreesJson: collectFolderTreesJson(),
    customPanelsJson: serializeCustomPanelsJson(),
    conversationsJson: collectConversationsJson(),
    settingsJson: collectSettingsJson(),
    ...deletedPayload(),
  };
}

function collectSettingsJson(): string {
  const state = useSettingsStore.getState() as unknown as Record<string, unknown>;
  const plain: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (typeof value === "function") continue;
    plain[key] = value;
  }
  return JSON.stringify(plain);
}
