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
