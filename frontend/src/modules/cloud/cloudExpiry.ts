import type { CloudResourceRow } from "../../ipc/bindings";
import { parseCloudDateMs } from "./cloudForm";
import { cloudListSlotKey, type CloudAccountInventory } from "./cloudInventory";

export const CLOUD_EXPIRY_WINDOW_DAYS = 30;
export const CLOUD_EXPIRY_URGENT_DAYS = 7;
export const CLOUD_EXPIRY_FIELDS = ["expiredTime", "expirationDate", "endDate", "autoReleaseTime"] as const;

export type CloudExpiryTone = "err" | "warn" | "info";

export type CloudExpiryItem = {
  capability: string;
  row: CloudResourceRow;
  field: string;
  expireAt: number;
  daysLeft: number;
  tone: CloudExpiryTone;
};

function nearestExpiry(row: CloudResourceRow): { field: string; expireAt: number } | null {
  let best: { field: string; expireAt: number } | null = null;
  for (const field of CLOUD_EXPIRY_FIELDS) {
    const expireAt = parseCloudDateMs(row.fields?.[field]);
    if (expireAt == null) continue;
    if (!best || expireAt < best.expireAt) best = { field, expireAt };
  }
  return best;
}

export function expiryTone(daysLeft: number): CloudExpiryTone {
  if (daysLeft < 0) return "err";
  if (daysLeft <= CLOUD_EXPIRY_URGENT_DAYS) return "warn";
  return "info";
}

export function formatCloudExpiryDate(ms: number): string {
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return "—";
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function collectExpiringCloudRows(
  inventory: Pick<CloudAccountInventory, "lists"> | undefined,
  selectedRegions: string[],
  capabilities: { id: string; scope?: string }[],
  now = Date.now(),
  windowDays = CLOUD_EXPIRY_WINDOW_DAYS,
): CloudExpiryItem[] {
  if (!inventory) return [];
  const limit = now + windowDays * 24 * 3600_000;
  const seen = new Set<string>();
  const out: CloudExpiryItem[] = [];

  for (const cap of capabilities) {
    const capability = cap.id;
    const slot = cloudListSlotKey(capability, cap.scope === "global" ? [] : selectedRegions);
    for (const row of inventory.lists[slot]?.rows ?? []) {
      const hit = nearestExpiry(row);
      if (!hit || hit.expireAt > limit) continue;
      const key = `${row.capability || capability}:${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const daysLeft = Math.floor((hit.expireAt - now) / 86_400_000);
      out.push({
        capability: row.capability || capability,
        row,
        field: hit.field,
        expireAt: hit.expireAt,
        daysLeft,
        tone: expiryTone(daysLeft),
      });
    }
  }

  out.sort((a, b) => a.expireAt - b.expireAt || a.row.name.localeCompare(b.row.name));
  return out;
}
