import { commands, type CloudAccountSnapshot, type CloudResourceFilter, type CloudResourceRow } from "../../ipc/bindings";
import { unwrapCommand, type UnwrapCommandOptions } from "../../ipc/result";

export function toCloudResourceFilter(partial: {
  regions?: string[];
  status?: string | null;
  query?: string | null;
} = {}): CloudResourceFilter {
  return {
    regions: partial.regions ?? [],
    status: partial.status ?? null,
    query: partial.query ?? null,
  };
}

export function cloudRowField(
  fields: CloudResourceRow["fields"] | undefined,
  key: string,
): string {
  if (!fields) return "";
  return fields[key] ?? "";
}

export async function loadCloudResources(
  accountId: string,
  capability: string,
  filter: { regions?: string[]; status?: string | null; query?: string | null } = {},
  options?: UnwrapCommandOptions,
): Promise<CloudResourceRow[]> {
  const raw = await unwrapCommand(
    commands.cloudListResources(accountId, capability, toCloudResourceFilter(filter)),
    options,
  );
  return Array.isArray(raw) ? raw : [];
}

export async function loadCloudAccount(
  accountId: string,
  options?: UnwrapCommandOptions,
): Promise<CloudAccountSnapshot> {
  return unwrapCommand(commands.cloudGetAccount(accountId), options);
}

export function filterCloudResourceRows(
  rows: CloudResourceRow[],
  selectedRegions: string[],
  global: boolean,
): CloudResourceRow[] {
  if (global || selectedRegions.length === 0) return rows;
  const regionSet = new Set(selectedRegions);
  return rows.filter((row) => !row.regionId || regionSet.has(row.regionId));
}

/** 全部地域 = 账户已配置地域；未配置时才用探测列表。避免把 ECS 全量地域拿去打 SWAS。 */
export function resolveCloudQueryRegions(
  selectedRegions: string[],
  liveRegionIds: string[],
  configuredRegions: string[],
): string[] {
  if (selectedRegions.length > 0) return selectedRegions;
  const configured = configuredRegions.map((id) => id.trim()).filter(Boolean);
  if (configured.length > 0) return configured;
  return liveRegionIds.map((id) => id.trim()).filter(Boolean);
}
