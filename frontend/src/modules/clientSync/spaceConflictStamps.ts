const STAMP_NAMES = new Set([
  "updatedat",
  "updateat",
  "modifiedat",
  "lastmodified",
  "lastmodifiedat",
  "updatetime",
  "updatedtime",
  "modifiedtime",
]);

export function isUpdateStampField(field: string): boolean {
  return STAMP_NAMES.has(field.replace(/_/g, "").toLowerCase());
}

function stampNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** 只有更新日期不同时，返回该采用哪一边。还有别的字段不同则返回 null。 */
export function stampOnlyDecision(current: string, saved: string): "current" | "saved" | null {
  let left: unknown;
  let right: unknown;
  try {
    left = current.trim() ? JSON.parse(current) : null;
    right = saved.trim() ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return null;
  if (Array.isArray(left) || Array.isArray(right)) return null;
  const cloud = left as Record<string, unknown>;
  const local = right as Record<string, unknown>;
  const fields = new Set([...Object.keys(cloud), ...Object.keys(local)]);
  let sawStampDiff = false;
  let cloudMax = Number.NEGATIVE_INFINITY;
  let localMax = Number.NEGATIVE_INFINITY;
  for (const field of fields) {
    const same = JSON.stringify(cloud[field] ?? null) === JSON.stringify(local[field] ?? null);
    if (!isUpdateStampField(field)) {
      if (!same) return null;
      continue;
    }
    const cloudStamp = stampNumber(cloud[field]);
    const localStamp = stampNumber(local[field]);
    if (cloudStamp == null && localStamp == null) {
      if (!same) return null;
      continue;
    }
    if (cloudStamp == null || localStamp == null || cloudStamp !== localStamp) sawStampDiff = true;
    if (cloudStamp != null) cloudMax = Math.max(cloudMax, cloudStamp);
    if (localStamp != null) localMax = Math.max(localMax, localStamp);
  }
  if (!sawStampDiff) return null;
  return localMax > cloudMax ? "saved" : "current";
}
