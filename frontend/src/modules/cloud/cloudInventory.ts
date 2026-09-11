import type {
  CloudAccountSnapshot,
  CloudRegion,
  CloudResourceDetail,
  CloudResourceRow,
} from "../../ipc/bindings";

/** 15s 内视为新鲜，打开列表/树不再打云厂商。 */
export const CLOUD_INVENTORY_FRESH_MS = 15_000;

export type CloudListCacheEntry = {
  rows: CloudResourceRow[];
  fetchedAt: number;
  error?: string | null;
};

export type CloudDetailCacheEntry = {
  detail: CloudResourceDetail;
  fetchedAt: number;
  error?: string | null;
};

export type CloudAccountCacheEntry = {
  snapshot: CloudAccountSnapshot;
  fetchedAt: number;
  error?: string | null;
};

export type CloudRegionsCacheEntry = {
  regions: CloudRegion[];
  fetchedAt: number;
  error?: string | null;
};

export type CloudAccountInventory = {
  lists: Record<string, CloudListCacheEntry>;
  details: Record<string, CloudDetailCacheEntry>;
  snapshot?: CloudAccountCacheEntry;
  regions?: CloudRegionsCacheEntry;
};

export const EMPTY_CLOUD_ACCOUNT_INVENTORY: CloudAccountInventory = {
  lists: {},
  details: {},
};

export function cloudRegionFingerprint(regions: string[] | undefined): string {
  const ids = [...new Set((regions ?? []).map((id) => id.trim()).filter(Boolean))].sort();
  return ids.length === 0 ? "*" : ids.join(",");
}

export function cloudListSlotKey(capability: string, regions: string[] | undefined): string {
  return `${capability.trim()}::${cloudRegionFingerprint(regions)}`;
}

export function cloudDetailSlotKey(
  capability: string,
  resourceId: string,
  regionId: string | undefined,
): string {
  return `${capability.trim()}::${resourceId.trim()}::${(regionId ?? "").trim()}`;
}

export function rowToCloudDetailStub(row: CloudResourceRow): CloudResourceDetail {
  return {
    id: row.id,
    name: row.name,
    capability: row.capability,
    regionId: row.regionId,
    status: row.status,
    fields: row.fields,
    consoleUrl: null,
  };
}

export function findCachedCloudRow(
  inventory: CloudAccountInventory | undefined,
  capability: string,
  resourceId: string,
): CloudResourceRow | undefined {
  if (!inventory) return undefined;
  const cap = capability.trim();
  const id = resourceId.trim();
  for (const entry of Object.values(inventory.lists)) {
    const hit = entry.rows.find((row) => row.id === id && (!row.capability || row.capability === cap));
    if (hit) return hit;
  }
  return undefined;
}

export function isCloudInventoryFresh(fetchedAt: number | undefined, now = Date.now()): boolean {
  if (fetchedAt == null || fetchedAt <= 0) return false;
  return now - fetchedAt < CLOUD_INVENTORY_FRESH_MS;
}

/**
 * 侧栏账户状态点：以账户快照连通性为准。
 * 单个能力清单失败（权限不足等）不得把整户打成 offline。
 */
export function cloudAccountStatusDot(
  inventory: CloudAccountInventory | undefined,
  refreshing = false,
): "online" | "connecting" | "offline" | "idle" {
  if (refreshing) return "connecting";
  const snapshot = inventory?.snapshot;
  if (snapshot) {
    const hasIdentity = Boolean(snapshot.snapshot?.callerId?.trim());
    if (hasIdentity || (!snapshot.error && Boolean(snapshot.fetchedAt))) {
      return "online";
    }
    if (snapshot.error) return "offline";
  }
  const listEntries = Object.values(inventory?.lists ?? {});
  if (listEntries.some((entry) => entry.fetchedAt && !entry.error)) return "online";
  if (listEntries.length > 0 && listEntries.every((entry) => Boolean(entry.error))) {
    return "offline";
  }
  return "idle";
}

/** 离线悬停文案：优先账户快照错误，否则取首个清单错误。 */
export function cloudAccountStatusError(
  inventory: CloudAccountInventory | undefined,
): string | null {
  if (cloudAccountStatusDot(inventory) !== "offline") return null;
  const snapshotError = inventory?.snapshot?.error?.trim();
  if (snapshotError) return snapshotError;
  for (const entry of Object.values(inventory?.lists ?? {})) {
    const message = entry.error?.trim();
    if (message) return message;
  }
  return null;
}
