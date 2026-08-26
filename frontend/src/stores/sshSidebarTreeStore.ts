/**
 * SSH 侧栏树形文件夹布局（嵌套文件夹 + 主机归属）。
 * 与 Connection.group 解耦；首次启动可将历史 group 一次性迁入文件夹。
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { createIndexedDBStorage } from "@/lib/indexedDbStorage";
import { scheduleClientModuleSync } from "../modules/clientSync/moduleSync";
import { normalizeSshGroup, OPENSSH_CONFIG_GROUP } from "../lib/sshGroups";

export type SshSidebarFolder = {
  id: string;
  name: string;
  /** 父文件夹 id；null 表示根级 */
  parentId: string | null;
};

type SshSidebarTreeState = {
  folders: SshSidebarFolder[];
  /** connectionId → folderId；未出现则挂在根级 */
  connectionFolderId: Record<string, string>;
  /** 根级与各文件夹内子节点顺序（folderId 或 connectionId，前缀 f: / c:） */
  orderByParent: Record<string, string[]>;
  /** 是否已完成 Connection.group → 文件夹 的一次性迁移 */
  groupsMigrated: boolean;
  /**
   * 用户主动删除、不再自动创建的侧栏文件夹名（如 ~/.ssh/config）。
   * 会写入团队快照，避免其他设备或云端拉取后再次自动建回。
   */
  dismissedAutoFolders: string[];
  createFolder: (name: string, parentId?: string | null) => string;
  renameFolder: (folderId: string, name: string) => void;
  deleteFolder: (folderId: string) => void;
  moveNode: (opts: {
    nodeKey: string;
    targetParentId: string | null;
    beforeKey?: string | null;
  }) => void;
  ensureConnectionListed: (connectionId: string) => void;
  pruneMissingConnections: (activeConnectionIds: string[]) => void;
  /**
   * 一次性：非「默认」的 group 建成根级文件夹并挂入主机。
   * 已迁移过则 no-op。
   */
  migrateFromConnectionGroups: (
    hosts: Array<{ id: string; group?: string | null }>,
  ) => void;
  /**
   * 将仍带 OpenSSH group、且尚未归属文件夹的主机，收入 ~/.ssh/config 文件夹。
   * 用于同步 config 后的增量归属。
   */
  adoptOpenSshSyncedHosts: (
    hosts: Array<{ id: string; group?: string | null }>,
  ) => void;
};

const ROOT_KEY = "__root__";
const STORAGE_KEY = "omnipanel.sshSidebarTree.v1";
const MANUAL_GROUPS_STORAGE_KEY = "omnipanel.ssh.manualGroups.v1";

function folderKey(id: string): string {
  return `f:${id}`;
}

function connectionKey(id: string): string {
  return `c:${id}`;
}

export function parseSshSidebarNodeKey(
  key: string,
): { kind: "folder" | "connection"; id: string } | null {
  if (key.startsWith("f:")) return { kind: "folder", id: key.slice(2) };
  if (key.startsWith("c:")) return { kind: "connection", id: key.slice(2) };
  return null;
}

export function sshSidebarFolderNodeKey(id: string): string {
  return folderKey(id);
}

export function sshSidebarConnectionNodeKey(id: string): string {
  return connectionKey(id);
}

function parentStorageKey(parentId: string | null): string {
  return parentId ?? ROOT_KEY;
}

function notifySshSidebarTreeChanged(): void {
  scheduleClientModuleSync();
}

function isDescendantFolder(
  folders: SshSidebarFolder[],
  folderId: string,
  maybeAncestorId: string,
): boolean {
  let cur: string | null = folderId;
  const byId = new Map(folders.map((f) => [f.id, f]));
  while (cur) {
    if (cur === maybeAncestorId) return true;
    cur = byId.get(cur)?.parentId ?? null;
  }
  return false;
}

function genFolderId(): string {
  return `sfolder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clearLegacyManualGroups(): void {
  try {
    localStorage.removeItem(MANUAL_GROUPS_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function dismissAutoFolderName(names: string[], folderName: string): string[] {
  const trimmed = folderName.trim();
  if (!trimmed) return names;
  return names.includes(trimmed) ? names : [...names, trimmed];
}

function restoreAutoFolderName(names: string[], folderName: string): string[] {
  const trimmed = folderName.trim();
  if (!trimmed) return names;
  return names.filter((name) => name !== trimmed);
}

function isAutoFolderDismissed(names: string[], folderName: string): boolean {
  return names.includes(folderName.trim());
}

export const useSshSidebarTreeStore = create<SshSidebarTreeState>()(
  persist(
    (set, get) => ({
      folders: [],
      connectionFolderId: {},
      orderByParent: { [ROOT_KEY]: [] },
      groupsMigrated: false,
      dismissedAutoFolders: [],

      createFolder: (name, parentId = null) => {
        const id = genFolderId();
        const trimmed = name.trim() || "新建文件夹";
        set((state) => {
          const parentKey = parentStorageKey(parentId);
          const order = [...(state.orderByParent[parentKey] ?? [])];
          const key = folderKey(id);
          if (!order.includes(key)) order.push(key);
          const dismissedAutoFolders =
            trimmed === OPENSSH_CONFIG_GROUP
              ? restoreAutoFolderName(state.dismissedAutoFolders, OPENSSH_CONFIG_GROUP)
              : state.dismissedAutoFolders;
          return {
            folders: [...state.folders, { id, name: trimmed, parentId }],
            dismissedAutoFolders,
            orderByParent: {
              ...state.orderByParent,
              [parentKey]: order,
              [id]: state.orderByParent[id] ?? [],
            },
          };
        });
        notifySshSidebarTreeChanged();
        return id;
      },

      renameFolder: (folderId, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        set((state) => ({
          folders: state.folders.map((f) =>
            f.id === folderId ? { ...f, name: trimmed } : f,
          ),
        }));
        notifySshSidebarTreeChanged();
      },

      deleteFolder: (folderId) => {
        set((state) => {
          const folder = state.folders.find((f) => f.id === folderId);
          if (!folder) return state;
          const parentKey = parentStorageKey(folder.parentId);
          const childOrder = [...(state.orderByParent[folderId] ?? [])];
          const parentOrder = [...(state.orderByParent[parentKey] ?? [])].filter(
            (k) => k !== folderKey(folderId),
          );
          for (const child of childOrder) {
            if (!parentOrder.includes(child)) parentOrder.push(child);
          }

          const connectionFolderId = { ...state.connectionFolderId };
          for (const [connId, fid] of Object.entries(connectionFolderId)) {
            if (fid === folderId) {
              if (folder.parentId) connectionFolderId[connId] = folder.parentId;
              else delete connectionFolderId[connId];
            }
          }

          const folders = state.folders
            .filter((f) => f.id !== folderId)
            .map((f) =>
              f.parentId === folderId ? { ...f, parentId: folder.parentId } : f,
            );

          const orderByParent = { ...state.orderByParent };
          delete orderByParent[folderId];
          orderByParent[parentKey] = parentOrder;

          const dismissedAutoFolders =
            folder.name === OPENSSH_CONFIG_GROUP
              ? dismissAutoFolderName(state.dismissedAutoFolders, OPENSSH_CONFIG_GROUP)
              : state.dismissedAutoFolders;

          return { folders, connectionFolderId, orderByParent, dismissedAutoFolders };
        });
        notifySshSidebarTreeChanged();
      },

      moveNode: ({ nodeKey, targetParentId, beforeKey = null }) => {
        const parsed = parseSshSidebarNodeKey(nodeKey);
        if (!parsed) return;

        set((state) => {
          if (
            parsed.kind === "folder" &&
            targetParentId &&
            (parsed.id === targetParentId ||
              isDescendantFolder(state.folders, targetParentId, parsed.id))
          ) {
            return state;
          }

          const nextFolders = state.folders.map((f) =>
            parsed.kind === "folder" && f.id === parsed.id
              ? { ...f, parentId: targetParentId }
              : f,
          );
          const connectionFolderId = { ...state.connectionFolderId };
          if (parsed.kind === "connection") {
            if (targetParentId) connectionFolderId[parsed.id] = targetParentId;
            else delete connectionFolderId[parsed.id];
          }

          const orderByParent: Record<string, string[]> = {};
          for (const [k, v] of Object.entries(state.orderByParent)) {
            orderByParent[k] = v.filter((item) => item !== nodeKey);
          }

          const destKey = parentStorageKey(targetParentId);
          const dest = [...(orderByParent[destKey] ?? [])];
          const insertAt =
            beforeKey && dest.includes(beforeKey) ? dest.indexOf(beforeKey) : dest.length;
          dest.splice(insertAt, 0, nodeKey);
          orderByParent[destKey] = dest;

          return {
            folders: nextFolders,
            connectionFolderId,
            orderByParent,
          };
        });
        notifySshSidebarTreeChanged();
      },

      ensureConnectionListed: (connectionId) => {
        const key = connectionKey(connectionId);
        const current = get();
        const folderId = current.connectionFolderId[connectionId] ?? null;
        const parentKey = parentStorageKey(folderId);
        const existing = current.orderByParent[parentKey] ?? [];
        if (existing.includes(key)) return;
        set((state) => {
          const listedFolderId = state.connectionFolderId[connectionId] ?? null;
          const listedParentKey = parentStorageKey(listedFolderId);
          const orderByParent: Record<string, string[]> = {};
          for (const [k, v] of Object.entries(state.orderByParent)) {
            orderByParent[k] = v.filter((item) => item !== key);
          }
          const dest = [...(orderByParent[listedParentKey] ?? [])];
          dest.push(key);
          orderByParent[listedParentKey] = dest;
          return { orderByParent };
        });
        notifySshSidebarTreeChanged();
      },

      pruneMissingConnections: (activeConnectionIds) => {
        const active = new Set(activeConnectionIds);
        set((state) => {
          const connectionFolderId: Record<string, string> = {};
          for (const [id, folderId] of Object.entries(state.connectionFolderId)) {
            if (active.has(id)) connectionFolderId[id] = folderId;
          }
          const orderByParent: Record<string, string[]> = {};
          for (const [k, v] of Object.entries(state.orderByParent)) {
            orderByParent[k] = v.filter((item) => {
              const parsed = parseSshSidebarNodeKey(item);
              if (!parsed) return false;
              if (parsed.kind === "folder") return true;
              return active.has(parsed.id);
            });
          }
          for (const id of activeConnectionIds) {
            const key = connectionKey(id);
            const folderId = connectionFolderId[id] ?? null;
            const parentKey = parentStorageKey(folderId);
            const order = orderByParent[parentKey] ?? (orderByParent[parentKey] = []);
            if (!order.includes(key)) order.push(key);
          }
          return { connectionFolderId, orderByParent };
        });
      },

      migrateFromConnectionGroups: (hosts) => {
        if (get().groupsMigrated) return;

        set((state) => {
          if (state.groupsMigrated) return state;

          const folders = [...state.folders];
          const connectionFolderId = { ...state.connectionFolderId };
          const orderByParent: Record<string, string[]> = {
            ...Object.fromEntries(
              Object.entries(state.orderByParent).map(([k, v]) => [k, [...v]]),
            ),
          };
          if (!orderByParent[ROOT_KEY]) orderByParent[ROOT_KEY] = [];

          const rootFolderByName = new Map<string, string>();
          for (const f of folders) {
            if (f.parentId == null) rootFolderByName.set(f.name, f.id);
          }

          const ensureRootFolder = (name: string): string => {
            const existing = rootFolderByName.get(name);
            if (existing) return existing;
            const id = genFolderId();
            folders.push({ id, name, parentId: null });
            rootFolderByName.set(name, id);
            const rootOrder = orderByParent[ROOT_KEY] ?? (orderByParent[ROOT_KEY] = []);
            const fk = folderKey(id);
            if (!rootOrder.includes(fk)) rootOrder.push(fk);
            orderByParent[id] = orderByParent[id] ?? [];
            return id;
          };

          for (const host of hosts) {
            const group = normalizeSshGroup(host.group);
            if (group === "默认") continue;
            if (
              group === OPENSSH_CONFIG_GROUP &&
              isAutoFolderDismissed(state.dismissedAutoFolders, OPENSSH_CONFIG_GROUP)
            ) {
              continue;
            }
            const folderId = ensureRootFolder(group);
            connectionFolderId[host.id] = folderId;
            const ck = connectionKey(host.id);
            // 从各层 order 去掉，再挂到目标文件夹
            for (const [k, v] of Object.entries(orderByParent)) {
              orderByParent[k] = v.filter((item) => item !== ck);
            }
            const dest = orderByParent[folderId] ?? (orderByParent[folderId] = []);
            if (!dest.includes(ck)) dest.push(ck);
          }

          // 根级补齐未分组主机
          for (const host of hosts) {
            if (connectionFolderId[host.id]) continue;
            const ck = connectionKey(host.id);
            const rootOrder = orderByParent[ROOT_KEY] ?? (orderByParent[ROOT_KEY] = []);
            if (!rootOrder.includes(ck)) rootOrder.push(ck);
          }

          clearLegacyManualGroups();
          return {
            folders,
            connectionFolderId,
            orderByParent,
            groupsMigrated: true,
          };
        });
      },

      adoptOpenSshSyncedHosts: (hosts) => {
        if (isAutoFolderDismissed(get().dismissedAutoFolders, OPENSSH_CONFIG_GROUP)) {
          return;
        }
        const toAdopt = hosts.filter((h) => {
          const g = normalizeSshGroup(h.group);
          return g === OPENSSH_CONFIG_GROUP && !get().connectionFolderId[h.id];
        });
        if (toAdopt.length === 0) return;

        let folderId = get().folders.find(
          (f) => f.parentId == null && f.name === OPENSSH_CONFIG_GROUP,
        )?.id;
        if (!folderId) {
          folderId = get().createFolder(OPENSSH_CONFIG_GROUP, null);
        }
        for (const host of toAdopt) {
          get().moveNode({
            nodeKey: connectionKey(host.id),
            targetParentId: folderId,
          });
        }
      },
    }),
    {
      name: STORAGE_KEY,
      version: 2,
      storage: createJSONStorage(createIndexedDBStorage),
      partialize: (state) => ({
        folders: state.folders,
        connectionFolderId: state.connectionFolderId,
        orderByParent: state.orderByParent,
        groupsMigrated: state.groupsMigrated,
        dismissedAutoFolders: state.dismissedAutoFolders,
      }),
      migrate: (persisted, version) => {
        const state = persisted as Partial<SshSidebarTreeState>;
        if (version < 2) {
          state.dismissedAutoFolders = state.dismissedAutoFolders ?? [];
        }
        return state as SshSidebarTreeState;
      },
    },
  ),
);

export type SshSidebarTreeSnapshot = {
  folders: SshSidebarFolder[];
  connectionFolderId: Record<string, string>;
  orderByParent: Record<string, string[]>;
  groupsMigrated: boolean;
  dismissedAutoFolders?: string[];
};

export function serializeSshSidebarTree(): string {
  const {
    folders,
    connectionFolderId,
    orderByParent,
    groupsMigrated,
    dismissedAutoFolders,
  } = useSshSidebarTreeStore.getState();
  return JSON.stringify({
    folders,
    connectionFolderId,
    orderByParent,
    groupsMigrated,
    dismissedAutoFolders,
  });
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string" && item.trim()) out[key] = item;
  }
  return out;
}

function asOrderByParent(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { [ROOT_KEY]: [] };
  }
  const out: Record<string, string[]> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(item)) continue;
    out[key] = item.filter((entry): entry is string => typeof entry === "string");
  }
  if (!out[ROOT_KEY]) out[ROOT_KEY] = [];
  return out;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function parseSshSidebarTreeSnapshot(
  raw: string | null | undefined,
): SshSidebarTreeSnapshot | null {
  if (!raw?.trim()) return null;
  try {
    const data = JSON.parse(raw) as {
      folders?: unknown;
      connectionFolderId?: unknown;
      orderByParent?: unknown;
      groupsMigrated?: unknown;
      dismissedAutoFolders?: unknown;
    };
    if (!data || !Array.isArray(data.folders)) return null;
    const folders: SshSidebarFolder[] = [];
    for (const item of data.folders) {
      if (!item || typeof item !== "object") continue;
      const folder = item as { id?: unknown; name?: unknown; parentId?: unknown };
      if (typeof folder.id !== "string" || !folder.id.trim()) continue;
      if (typeof folder.name !== "string") continue;
      folders.push({
        id: folder.id,
        name: folder.name,
        parentId:
          typeof folder.parentId === "string" && folder.parentId.trim()
            ? folder.parentId
            : null,
      });
    }
    const snapshot: SshSidebarTreeSnapshot = {
      folders,
      connectionFolderId: asStringRecord(data.connectionFolderId),
      orderByParent: asOrderByParent(data.orderByParent),
      groupsMigrated: Boolean(data.groupsMigrated),
    };
    if (data.dismissedAutoFolders !== undefined) {
      snapshot.dismissedAutoFolders = asStringArray(data.dismissedAutoFolders);
    }
    return snapshot;
  } catch {
    return null;
  }
}

const EMPTY_SSH_SIDEBAR_TREE: SshSidebarTreeSnapshot = {
  folders: [],
  connectionFolderId: {},
  orderByParent: { [ROOT_KEY]: [] },
  groupsMigrated: true,
  dismissedAutoFolders: [],
};

/**
 * 云端拉取后写入本机。
 * merge：旧快照无此字段时保留本机；replace：切换团队时缺字段则清空，避免串数据。
 */
export function applySshSidebarTreeJson(
  raw: string | null | undefined,
  mode: "merge" | "replace" = "merge",
): void {
  const parsed = parseSshSidebarTreeSnapshot(raw);
  if (!parsed) {
    if (mode === "replace") {
      useSshSidebarTreeStore.setState(EMPTY_SSH_SIDEBAR_TREE);
    }
    return;
  }
  const current = useSshSidebarTreeStore.getState();
  useSshSidebarTreeStore.setState({
    folders: parsed.folders,
    connectionFolderId: parsed.connectionFolderId,
    orderByParent: parsed.orderByParent,
    groupsMigrated: true,
    dismissedAutoFolders:
      parsed.dismissedAutoFolders ??
      (mode === "replace" ? [] : current.dismissedAutoFolders),
  });
}

export type SshSidebarTreeItem =
  | { kind: "folder"; folder: SshSidebarFolder }
  | { kind: "connection"; connectionId: string };

function sshSidebarTreeItemLabel(
  item: SshSidebarTreeItem,
  getConnectionName: (id: string) => string,
): string {
  return item.kind === "folder" ? item.folder.name : getConnectionName(item.connectionId);
}

function compareSshSidebarTreeItems(
  a: SshSidebarTreeItem,
  b: SshSidebarTreeItem,
  getConnectionName: (id: string) => string,
): number {
  const folderFirst = Number(b.kind === "folder") - Number(a.kind === "folder");
  if (folderFirst !== 0) return folderFirst;
  return sshSidebarTreeItemLabel(a, getConnectionName).localeCompare(
    sshSidebarTreeItemLabel(b, getConnectionName),
    undefined,
    { sensitivity: "base", numeric: true },
  );
}

/** 列出某父级下的有序子节点（仅一层）。 */
export function listSshSidebarChildren(
  state: Pick<SshSidebarTreeState, "folders" | "orderByParent" | "connectionFolderId">,
  parentId: string | null,
  connectionIds: string[],
  getConnectionName?: (id: string) => string,
): SshSidebarTreeItem[] {
  const parentKey = parentStorageKey(parentId);
  const active = new Set(connectionIds);
  const folderById = new Map(state.folders.map((f) => [f.id, f]));
  const ordered = state.orderByParent[parentKey] ?? [];
  const items: SshSidebarTreeItem[] = [];
  const seen = new Set<string>();

  for (const key of ordered) {
    const parsed = parseSshSidebarNodeKey(key);
    if (!parsed || seen.has(key)) continue;
    if (parsed.kind === "folder") {
      const folder = folderById.get(parsed.id);
      if (!folder || folder.parentId !== parentId) continue;
      seen.add(key);
      items.push({ kind: "folder", folder });
    } else if (active.has(parsed.id)) {
      const assigned = state.connectionFolderId[parsed.id] ?? null;
      if (assigned !== parentId) continue;
      seen.add(key);
      items.push({ kind: "connection", connectionId: parsed.id });
    }
  }

  for (const folder of state.folders) {
    if (folder.parentId !== parentId) continue;
    const key = folderKey(folder.id);
    if (seen.has(key)) continue;
    items.push({ kind: "folder", folder });
  }
  for (const id of connectionIds) {
    const assigned = state.connectionFolderId[id] ?? null;
    if (assigned !== parentId) continue;
    const key = connectionKey(id);
    if (seen.has(key)) continue;
    items.push({ kind: "connection", connectionId: id });
  }

  if (getConnectionName) {
    items.sort((a, b) => compareSshSidebarTreeItems(a, b, getConnectionName));
  }

  return items;
}

export function collectAllSshSidebarTreeKeys(
  state: Pick<SshSidebarTreeState, "folders" | "orderByParent" | "connectionFolderId">,
  connectionIds: string[],
  connectionTreeKey: (connectionId: string) => string,
  parentId: string | null = null,
  getConnectionName?: (id: string) => string,
): string[] {
  const children = listSshSidebarChildren(
    state,
    parentId,
    connectionIds,
    getConnectionName,
  );
  const keys: string[] = [];
  for (const item of children) {
    if (item.kind === "folder") {
      keys.push(`ssh-folder:${item.folder.id}`);
      keys.push(
        ...collectAllSshSidebarTreeKeys(
          state,
          connectionIds,
          connectionTreeKey,
          item.folder.id,
          getConnectionName,
        ),
      );
    } else {
      keys.push(connectionTreeKey(item.connectionId));
    }
  }
  return keys;
}

export function parseSshSidebarFolderTreeKey(key: string): string | null {
  return key.startsWith("ssh-folder:") ? key.slice("ssh-folder:".length) : null;
}

export function makeSshHostTreeKey(connectionId: string): string {
  return `ssh:${connectionId}`;
}

/** 解析主机所属文件夹显示名；根级返回 null。 */
export function getSshHostFolderLabel(connectionId: string): string | null {
  const state = useSshSidebarTreeStore.getState();
  const folderId = state.connectionFolderId[connectionId];
  if (!folderId) return null;
  return state.folders.find((f) => f.id === folderId)?.name ?? null;
}
