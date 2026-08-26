import { useConnectionStore } from "../../stores/connectionStore";
import { useDockerSidebarTreeStore } from "../../stores/dockerSidebarTreeStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import {
  serializeSshSidebarTree,
  useSshSidebarTreeStore,
} from "../../stores/sshSidebarTreeStore";
import { collectFolderTreesJson } from "./folderTrees";
import { toIpcTombstones, useClientSyncTombstoneStore } from "./tombstones";

/** 上传前对齐各模块侧栏布局与本机连接列表，避免快照与 UI 不一致。 */
export function prepareLayoutStoresForModuleSync(): void {
  const connections = useConnectionStore.getState().connections;
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
 * 组装模块快照上传请求体（团队手动上传与自动推送共用）。
 * 会先修剪侧栏布局，再序列化，保证 OSS 快照与本机 UI 一致。
 */
export function collectModulesSyncPayload() {
  prepareLayoutStoresForModuleSync();
  return {
    workspacesJson: collectWorkspacesJson(),
    sshSidebarTreeJson: serializeSshSidebarTree(),
    folderTreesJson: collectFolderTreesJson(),
    ...deletedPayload(),
  };
}
