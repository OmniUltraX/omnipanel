/**
 * 侧栏文件夹按结构合并。
 * 远端优先：同一条资源两边都改了归属时用远端；只在一边出现的文件夹和归属都留下。
 * 同名且同一个父级的文件夹合成一个，避免两台各有一份「~/.ssh/config」。
 */

export type LayoutFolder = {
  id: string;
  name: string;
  parentId: string | null;
};

export type PlacementTree = {
  folders: LayoutFolder[];
  connectionFolderId: Record<string, string>;
  orderByParent: Record<string, string[]>;
};

const ROOT_KEYS = new Set(["__root__", "root"]);

export function mergePlacementTree(remote: PlacementTree, local: PlacementTree): PlacementTree {
  if (remote.folders.length === 0 && local.folders.length > 0) return local;
  if (local.folders.length === 0) return remote;
  const { folders, alias } = coalesceFolders(remote.folders, local.folders);
  return {
    ...remote,
    folders,
    connectionFolderId: mergeIdMap(remote.connectionFolderId, local.connectionFolderId, alias),
    orderByParent: mergeOrderMap(remote.orderByParent, local.orderByParent, alias),
  };
}

export function mergeNullableParents(
  remoteFolders: LayoutFolder[],
  localFolders: LayoutFolder[],
  remoteParents: Record<string, string | null>,
  localParents: Record<string, string | null>,
): { folders: LayoutFolder[]; parents: Record<string, string | null> } {
  if (remoteFolders.length === 0 && localFolders.length > 0) {
    return { folders: localFolders, parents: localParents };
  }
  if (localFolders.length === 0) {
    return { folders: remoteFolders, parents: remoteParents };
  }
  const { folders, alias } = coalesceFolders(remoteFolders, localFolders);
  const parents: Record<string, string | null> = {};
  for (const [id, folderId] of Object.entries(remoteParents)) {
    parents[id] = folderId == null ? null : canon(alias, folderId);
  }
  for (const [id, folderId] of Object.entries(localParents)) {
    if (id in parents) continue;
    parents[id] = folderId == null ? null : canon(alias, folderId);
  }
  return { folders, parents };
}

export type ProtocolLayout = {
  folders: LayoutFolder[];
  collectionParents: Record<string, string | null>;
  requestParents: Record<string, string | null>;
  entryParents: Record<string, string | null>;
  siblingOrder: Record<string, string[]>;
  expandedFolderIds: string[];
  expandedCollectionIds: string[];
};

export function mergeProtocolLayout(remote: ProtocolLayout, local: ProtocolLayout): ProtocolLayout {
  if (remote.folders.length === 0 && local.folders.length > 0) return local;
  if (local.folders.length === 0) return remote;
  const { folders, alias } = coalesceFolders(remote.folders, local.folders);
  const parents = (remoteParents: Record<string, string | null>, localParents: Record<string, string | null>) => {
    const out: Record<string, string | null> = {};
    for (const [id, folderId] of Object.entries(remoteParents)) {
      out[id] = folderId == null ? null : canon(alias, folderId);
    }
    for (const [id, folderId] of Object.entries(localParents)) {
      if (id in out) continue;
      out[id] = folderId == null ? null : canon(alias, folderId);
    }
    return out;
  };
  return {
    folders,
    collectionParents: parents(remote.collectionParents, local.collectionParents),
    requestParents: parents(remote.requestParents, local.requestParents),
    entryParents: parents(remote.entryParents, local.entryParents),
    siblingOrder: mergeOrderMap(remote.siblingOrder, local.siblingOrder, alias),
    expandedFolderIds: mergeStringLists(remote.expandedFolderIds, local.expandedFolderIds, alias),
    expandedCollectionIds: mergeStringLists(
      remote.expandedCollectionIds,
      local.expandedCollectionIds,
      alias,
    ),
  };
}

export function mergeStringLists(remote: string[] | undefined, local: string[] | undefined, alias: Map<string, string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of [...(remote ?? []), ...(local ?? [])]) {
    const next = canon(alias, item);
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
  }
  return out;
}

export function coalesceFolders(
  remote: LayoutFolder[],
  local: LayoutFolder[],
): { folders: LayoutFolder[]; alias: Map<string, string> } {
  const folders = remote.map((folder) => ({ ...folder }));
  const alias = new Map<string, string>();
  const nameIndex = new Map<string, string>();
  for (const folder of folders) {
    nameIndex.set(nameKey(folder.parentId, folder.name), folder.id);
  }
  const remoteIds = new Set(remote.map((folder) => folder.id));
  let pending = local.filter((folder) => !remoteIds.has(folder.id)).map((folder) => ({ ...folder }));
  let spins = pending.length + 1;
  while (pending.length > 0 && spins > 0) {
    spins -= 1;
    const batch = pending;
    pending = [];
    const known = new Set(folders.map((folder) => folder.id));
    const deferred: LayoutFolder[] = [];
    for (const folder of batch) {
      const parentReady =
        folder.parentId == null || known.has(folder.parentId) || alias.has(folder.parentId);
      if (!parentReady) {
        deferred.push(folder);
        continue;
      }
      placeFolder(folders, alias, nameIndex, folder);
    }
    if (deferred.length === 0) break;
    if (deferred.length === batch.length) {
      for (const folder of deferred) placeFolder(folders, alias, nameIndex, folder);
      break;
    }
    pending = deferred;
  }
  return { folders, alias };
}

function placeFolder(
  folders: LayoutFolder[],
  alias: Map<string, string>,
  nameIndex: Map<string, string>,
  folder: LayoutFolder,
): void {
  if (folders.some((have) => have.id === folder.id)) return;
  const canonicalParent =
    folder.parentId == null ? null : alias.get(folder.parentId) ?? folder.parentId;
  const key = nameKey(canonicalParent, folder.name);
  const existing = nameIndex.get(key);
  if (existing) {
    alias.set(folder.id, existing);
    return;
  }
  const placed = { id: folder.id, name: folder.name, parentId: canonicalParent };
  nameIndex.set(key, placed.id);
  folders.push(placed);
}

function nameKey(parentId: string | null, name: string): string {
  return `${parentId ?? ""}\u0001${name}`;
}

function canon(alias: Map<string, string>, id: string): string {
  return alias.get(id) ?? id;
}

function remapNode(alias: Map<string, string>, key: string): string {
  const direct = alias.get(key);
  if (direct) return direct;
  for (const prefix of ["f:", "folder:"]) {
    if (key.startsWith(prefix)) {
      const next = alias.get(key.slice(prefix.length));
      if (next) return `${prefix}${next}`;
    }
  }
  return key;
}

function mergeIdMap(
  remote: Record<string, string>,
  local: Record<string, string>,
  alias: Map<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, folderId] of Object.entries(remote)) {
    out[id] = canon(alias, folderId);
  }
  for (const [id, folderId] of Object.entries(local)) {
    if (out[id]) continue;
    out[id] = canon(alias, folderId);
  }
  return out;
}

export function mergeOrderMap(
  remote: Record<string, string[]>,
  local: Record<string, string[]>,
  alias: Map<string, string>,
): Record<string, string[]> {
  const keys = new Set([...Object.keys(remote), ...Object.keys(local)]);
  const grouped = new Map<string, string[]>();
  for (const key of keys) {
    const canonKey = ROOT_KEYS.has(key) ? key : remapNode(alias, key);
    const list = grouped.get(canonKey) ?? [];
    pushUnique(list, (remote[key] ?? []).map((item) => remapNode(alias, item)));
    pushUnique(list, (local[key] ?? []).map((item) => remapNode(alias, item)));
    grouped.set(canonKey, list);
  }
  return Object.fromEntries(grouped);
}

function pushUnique(out: string[], items: string[]): void {
  for (const item of items) {
    if (!out.includes(item)) out.push(item);
  }
}
