export function cloudStatusTone(status: string | undefined): "ok" | "warn" | "err" | "muted" {
  const value = (status ?? "").trim().toLowerCase();
  if (!value) return "muted";
  if (value === "3") return "ok";
  if (value === "1") return "warn";
  if (value === "2") return "err";
  if (
    /running|active|enable|available|online|inuse|in_use|attached|accept|vpc|ok|healthy|issued|accomplished/.test(
      value,
    )
  ) {
    return "ok";
  }
  if (/willexpired/.test(value)) return "warn";
  if (/stop|inactive|disable|offline|drop|reject|released|expired|error|fail|unhealthy/.test(value)) {
    return "err";
  }
  if (/pending|starting|stopping|creating|classic|unknown|init/.test(value)) {
    return "warn";
  }
  return "muted";
}

export function cloudPolicyTone(policy: string | undefined): "ok" | "err" | "muted" {
  const value = (policy ?? "").trim().toLowerCase();
  if (value === "accept" || value === "allow") return "ok";
  if (value === "drop" || value === "deny" || value === "reject") return "err";
  return "muted";
}

export const CLOUD_HIGHLIGHT_KEYS = [
  "publicIp",
  "privateIp",
  "connectionString",
  "port",
  "vpcId",
  "ruleCount",
  "instanceClass",
  "engine",
  "expiredTime",
  "expirationDate",
  "endDate",
  "bandwidth",
  "instanceId",
  "instanceCount",
  "diskCount",
  "snapshotCount",
  "description",
] as const;

export async function copyCloudText(value: string): Promise<boolean> {
  const text = value.trim();
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
