import type { HttpCollection, HttpHistoryEntry, SavedHttpRequest } from "../../ipc/bindings";
import type { ProtocolTabKey } from "../../lib/protocolLabConfig";
import type { ProtocolLabEntry } from "../../stores/protocolLabEntryStore";
import type {
  ProtocolDropTarget,
  ProtocolHttpFolder,
  ProtocolTreeNodeKey,
} from "../../stores/protocolHttpLayoutStore";

export type ProtocolTreeEntry =
  | { kind: "folder"; folder: ProtocolHttpFolder; key: ProtocolTreeNodeKey }
  | { kind: "request"; request: SavedHttpRequest; key: ProtocolTreeNodeKey }
  | { kind: "entry"; entry: ProtocolLabEntry; key: ProtocolTreeNodeKey };

export function listProtocolTreeChildren(
  parentId: string | null,
  folders: ProtocolHttpFolder[],
  collections: HttpCollection[],
  requests: SavedHttpRequest[],
  collectionParents: Record<string, string | null>,
  requestParents: Record<string, string | null>,
  entryParents: Record<string, string | null>,
  labEntries: ProtocolLabEntry[],
  siblingOrder: Record<string, ProtocolTreeNodeKey[]>,
): ProtocolTreeEntry[] {
  const parentKey = parentId ? `folder:${parentId}` : "root";

  const folderEntries: ProtocolTreeEntry[] = folders
    .filter((f) => f.parentId === parentId)
    .map((folder) => ({
      kind: "folder" as const,
      folder,
      key: `folder:${folder.id}`,
    }));

  const collectionIdsInFolder = new Set(
    collections
      .filter((col) => (collectionParents[col.id] ?? null) === parentId)
      .map((col) => col.id),
  );

  const requestEntries: ProtocolTreeEntry[] = requests
    .filter((req) => {
      if (req.collectionId) {
        return collectionIdsInFolder.has(req.collectionId);
      }
      return (requestParents[req.id] ?? null) === parentId;
    })
    .map((request) => ({
      kind: "request" as const,
      request,
      key: `request:${request.id}`,
    }));

  const entryItems: ProtocolTreeEntry[] = labEntries
    .filter((entry) => (entryParents[entry.id] ?? null) === parentId)
    .map((entry) => ({
      kind: "entry" as const,
      entry,
      key: `entry:${entry.id}`,
    }));

  const merged = new Map<ProtocolTreeNodeKey, ProtocolTreeEntry>();
  for (const entry of [...folderEntries, ...requestEntries, ...entryItems]) {
    merged.set(entry.key, entry);
  }

  const orderedKeys = siblingOrder[parentKey] ?? [];
  const result: ProtocolTreeEntry[] = [];
  const used = new Set<ProtocolTreeNodeKey>();

  for (const key of orderedKeys) {
    const entry = merged.get(key);
    if (entry) {
      result.push(entry);
      used.add(key);
    }
  }

  const rest = [...merged.values()]
    .filter((entry) => !used.has(entry.key))
    .sort((a, b) => compareEntries(a, b));

  return [...result, ...rest];
}

function compareEntries(a: ProtocolTreeEntry, b: ProtocolTreeEntry): number {
  if (a.kind !== b.kind) {
    if (a.kind === "folder") return -1;
    if (b.kind === "folder") return 1;
    return a.kind === "request" ? -1 : 1;
  }
  const nameA =
    a.kind === "folder" ? a.folder.name : a.kind === "request" ? a.request.name : a.entry.name;
  const nameB =
    b.kind === "folder" ? b.folder.name : b.kind === "request" ? b.request.name : b.entry.name;
  return nameA.localeCompare(nameB, undefined, { sensitivity: "base" });
}

export function listCollectionRequests(
  collectionId: string,
  requests: SavedHttpRequest[],
  siblingOrder: Record<string, ProtocolTreeNodeKey[]>,
): Extract<ProtocolTreeEntry, { kind: "request" }>[] {
  const matched = requests
    .filter((req) => req.collectionId === collectionId)
    .map((request) => ({
      kind: "request" as const,
      request,
      key: `request:${request.id}` as ProtocolTreeNodeKey,
    }));

  const order = siblingOrder[`collection:${collectionId}`] ?? [];
  const map = new Map(matched.map((entry) => [entry.key, entry]));
  const result: Extract<ProtocolTreeEntry, { kind: "request" }>[] = [];
  const used = new Set<ProtocolTreeNodeKey>();

  for (const key of order) {
    const entry = map.get(key);
    if (entry) {
      result.push(entry);
      used.add(key);
    }
  }

  for (const entry of matched) {
    if (!used.has(entry.key)) {
      result.push(entry);
    }
  }

  return result;
}

export function resolveEntryParent(
  entry: ProtocolTreeEntry,
  requestParents: Record<string, string | null>,
  collectionParents: Record<string, string | null>,
  entryParents: Record<string, string | null>,
): ProtocolDropTarget {
  if (entry.kind === "folder") {
    return entry.folder.parentId
      ? { kind: "folder", folderId: entry.folder.parentId }
      : { kind: "root" };
  }
  if (entry.kind === "entry") {
    const parentId = entryParents[entry.entry.id] ?? null;
    return parentId ? { kind: "folder", folderId: parentId } : { kind: "root" };
  }
  if (entry.request.collectionId) {
    const folderId = collectionParents[entry.request.collectionId] ?? null;
    return folderId ? { kind: "folder", folderId } : { kind: "root" };
  }
  const parentId = requestParents[entry.request.id] ?? null;
  return parentId ? { kind: "folder", folderId: parentId } : { kind: "root" };
}

export function listSiblingKeys(
  target: ProtocolDropTarget,
  folders: ProtocolHttpFolder[],
  collections: HttpCollection[],
  requests: SavedHttpRequest[],
  collectionParents: Record<string, string | null>,
  requestParents: Record<string, string | null>,
  entryParents: Record<string, string | null>,
  labEntries: ProtocolLabEntry[],
  siblingOrder: Record<string, ProtocolTreeNodeKey[]>,
): ProtocolTreeNodeKey[] {
  if (target.kind === "collection") {
    return listCollectionRequests(target.collectionId, requests, siblingOrder).map(
      (entry) => entry.key,
    );
  }
  const parentId = target.kind === "root" ? null : target.folderId;
  return listProtocolTreeChildren(
    parentId,
    folders,
    collections,
    requests,
    collectionParents,
    requestParents,
    entryParents,
    labEntries,
    siblingOrder,
  ).map((entry) => entry.key);
}

export function resolveDropPosition(
  event: { clientY: number },
  rowEl: HTMLElement,
  entryKind: ProtocolTreeEntry["kind"],
): "before" | "after" | "inside" {
  const rect = rowEl.getBoundingClientRect();
  const y = event.clientY - rect.top;
  if (entryKind === "request" || entryKind === "entry") {
    return y < rect.height * 0.5 ? "before" : "after";
  }
  if (y < rect.height * 0.25) return "before";
  if (y > rect.height * 0.75) return "after";
  return "inside";
}

export function beforeKeyForAfterPosition(
  targetKey: ProtocolTreeNodeKey,
  siblingKeys: ProtocolTreeNodeKey[],
): ProtocolTreeNodeKey | null {
  const index = siblingKeys.indexOf(targetKey);
  if (index < 0) return null;
  return siblingKeys[index + 1] ?? null;
}

export function filterHistoryForRequest(
  history: HttpHistoryEntry[],
  request: SavedHttpRequest | null | undefined,
): HttpHistoryEntry[] {
  if (!request) return [];
  return history.filter((entry) => {
    if (entry.requestId) {
      return entry.requestId === request.id;
    }
    return (
      entry.method.toUpperCase() === request.method.toUpperCase() &&
      entry.url === request.url
    );
  });
}

export function methodColor(method: string): string {
  const m = method.toUpperCase();
  if (m === "GET") return "var(--success, #4caf50)";
  if (m === "POST") return "var(--warning, #ff9800)";
  if (m === "PUT") return "var(--info, #2196f3)";
  if (m === "PATCH") return "var(--info, #9c27b0)";
  if (m === "DELETE") return "var(--danger, #f44336)";
  if (m === "WEBSOCKET") return "var(--accent)";
  return "var(--text-dim)";
}

export function formatMethodBadge(method: string): string {
  const m = method.toUpperCase();
  if (m === "DELETE") return "DEL";
  if (m === "WEBSOCKET") return "WS";
  return m;
}

export function protocolColor(protocol: ProtocolTabKey): string {
  const map: Partial<Record<ProtocolTabKey, string>> = {
    http: "var(--info, #2196f3)",
    mqtt: "var(--success, #4caf50)",
    pubsub: "var(--warning, #ff9800)",
    serial: "var(--accent)",
    grpc: "var(--info, #9c27b0)",
    sniffer: "var(--danger, #f44336)",
    modbus: "var(--meta)",
  };
  return map[protocol] ?? "var(--meta)";
}

export function formatProtocolBadge(protocol: ProtocolTabKey): string {
  const map: Partial<Record<ProtocolTabKey, string>> = {
    http: "HTTP",
    mqtt: "MQTT",
    pubsub: "PS",
    serial: "SER",
    grpc: "RPC",
    sniffer: "CAP",
    modbus: "MB",
  };
  return map[protocol] ?? protocol.toUpperCase().slice(0, 3);
}

export function resolveTreeEntryByKey(
  key: ProtocolTreeNodeKey,
  folders: ProtocolHttpFolder[],
  requests: SavedHttpRequest[],
  labEntries: ProtocolLabEntry[],
): ProtocolTreeEntry | null {
  if (key.startsWith("folder:")) {
    const folder = folders.find((item) => item.id === key.slice("folder:".length));
    return folder ? { kind: "folder", folder, key } : null;
  }
  if (key.startsWith("request:")) {
    const request = requests.find((item) => item.id === key.slice("request:".length));
    return request ? { kind: "request", request, key } : null;
  }
  if (key.startsWith("entry:")) {
    const entry = labEntries.find((item) => item.id === key.slice("entry:".length));
    return entry ? { kind: "entry", entry, key } : null;
  }
  return null;
}
