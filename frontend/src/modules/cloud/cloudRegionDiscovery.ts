import type { CloudRegion } from "../../ipc/bindings";
import { cloudRegionLabel } from "./cloudForm";
import { useCloudInventoryStore } from "../../stores/cloudInventoryStore";

export function cloudRegionRowLabel(region: CloudRegion): string {
  return cloudRegionLabel(region.regionId, region.localName);
}

export function invalidateCloudAccountRegions(accountId?: string): void {
  useCloudInventoryStore.getState().clearRegions(accountId);
}

export async function loadCloudAccountRegions(accountId: string): Promise<CloudRegion[]> {
  const id = accountId.trim();
  if (!id) return [];
  return useCloudInventoryStore.getState().ensureRegions(id, { quiet: true });
}

export function fallbackCloudRegions(regionIds: string[]): CloudRegion[] {
  return regionIds
    .map((regionId) => regionId.trim())
    .filter(Boolean)
    .map((regionId) => ({
      regionId,
      localName: "",
      capabilities: [],
    }));
}
