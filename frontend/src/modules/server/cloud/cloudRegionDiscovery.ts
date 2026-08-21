import { commands, type CloudRegion } from "../../../ipc/bindings";
import { unwrapCommand } from "../../../ipc/result";
import { cloudRegionLabel } from "./cloudForm";

type CacheEntry = { regions: CloudRegion[]; at: number };

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<CloudRegion[]>>();
const TTL_MS = 5 * 60 * 1000;

export function cloudRegionRowLabel(region: CloudRegion): string {
  return cloudRegionLabel(region.regionId, region.localName);
}

export function invalidateCloudAccountRegions(accountId?: string): void {
  if (accountId) {
    cache.delete(accountId);
    return;
  }
  cache.clear();
}

export async function loadCloudAccountRegions(accountId: string): Promise<CloudRegion[]> {
  const id = accountId.trim();
  if (!id) return [];
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit.regions;
  }
  const pending = inflight.get(id);
  if (pending) return pending;

  const task = (async () => {
    try {
      const raw = await unwrapCommand(commands.cloudListRegions(id));
      const regions = Array.isArray(raw) ? raw.filter((item) => item.regionId?.trim()) : [];
      cache.set(id, { regions, at: Date.now() });
      return regions;
    } finally {
      inflight.delete(id);
    }
  })();
  inflight.set(id, task);
  return task;
}

export function fallbackCloudRegions(regionIds: string[]): CloudRegion[] {
  return regionIds
    .map((regionId) => regionId.trim())
    .filter(Boolean)
    .map((regionId) => ({
      regionId,
      localName: "",
      hasEcs: false,
      hasSwas: false,
    }));
}
