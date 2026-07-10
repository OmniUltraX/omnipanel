import type { ServerEntry } from "./serverConnection";

export function websiteRowId(row: Record<string, unknown>, index: number): string {
  return String(row.id ?? row.webname ?? row.domain ?? index);
}

export function websiteRowLabel(row: Record<string, unknown>): string {
  return String(row.primaryDomain ?? row.domain ?? row.name ?? row.webname ?? row.id ?? "—");
}

export function certificateRowId(row: Record<string, unknown>, index: number): string {
  return String(row.id ?? row.domain ?? row.primaryDomain ?? row.dns ?? index);
}

export function certificateRowLabel(row: Record<string, unknown>): string {
  return String(row.domain ?? row.primaryDomain ?? row.dns ?? row.name ?? "—");
}

export function makeServerTreeKey(
  serverId: string,
  category?: "apps" | "websites" | "certificates",
  itemId?: string,
): string {
  if (!category) return `server:${serverId}`;
  if (!itemId) return `server:${serverId}:${category}`;
  return `server:${serverId}:${category}:${itemId}`;
}

export function serverSupportsResources(server: ServerEntry): boolean {
  return server.serviceType === "1panel" || server.serviceType === "bt";
}
