import type { HttpCollection, HttpHistoryEntry, SavedHttpRequest } from "../../ipc/bindings";
import type {
  ProtocolHttpFolder,
  ProtocolTreeNodeKey,
} from "../../stores/protocolHttpLayoutStore";

export type ProtocolTreeEntry =
  | { kind: "folder"; folder: ProtocolHttpFolder; key: ProtocolTreeNodeKey }
  | { kind: "collection"; collection: HttpCollection; key: ProtocolTreeNodeKey }
  | { kind: "request"; request: SavedHttpRequest; key: ProtocolTreeNodeKey };

export function listProtocolTreeChildren(
  parentId: string | null,
  folders: ProtocolHttpFolder[],
  _collections: HttpCollection[],
  requests: SavedHttpRequest[],
  _collectionParents: Record<string, string | null>,
  requestParents: Record<string, string | null>,
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

  const requestEntries: ProtocolTreeEntry[] = requests
    .filter((req) => (requestParents[req.id] ?? null) === parentId)
    .map((request) => ({
      kind: "request" as const,
      request,
      key: `request:${request.id}`,
    }));

  const merged = new Map<ProtocolTreeNodeKey, ProtocolTreeEntry>();
  for (const entry of [...folderEntries, ...requestEntries]) {
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
  const rank = (entry: ProtocolTreeEntry) => {
    if (entry.kind === "folder") return 0;
    if (entry.kind === "collection") return 1;
    return 2;
  };
  const rankDiff = rank(a) - rank(b);
  if (rankDiff !== 0) return rankDiff;
  const nameA =
    a.kind === "folder" ? a.folder.name : a.kind === "collection" ? a.collection.name : a.request.name;
  const nameB =
    b.kind === "folder" ? b.folder.name : b.kind === "collection" ? b.collection.name : b.request.name;
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
  return "var(--text-dim)";
}
