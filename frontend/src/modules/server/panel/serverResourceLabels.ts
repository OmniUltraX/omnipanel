import type { ServerEntry } from "./serverConnection";
import type { ServerDetailTab } from "./ServerWorkspace";

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
  category?: ServerDetailTab,
  itemId?: string,
): string {
  // processes 仅存在于 dock 分段 Tab，侧栏树无对应节点，高亮服务器根节点即可
  if (!category || category === "processes") return `server:${serverId}`;
  if (!itemId) return `server:${serverId}:${category}`;
  return `server:${serverId}:${category}:${itemId}`;
}

export function serverSupportsResources(server: ServerEntry): boolean {
  return server.serviceType === "1panel" || server.serviceType === "bt";
}
