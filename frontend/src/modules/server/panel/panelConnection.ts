import type { Connection } from "../../../ipc/bindings";
import type { ServerEntry } from "./serverConnection";
import { parsePanelConfig } from "./serverConnection";

export interface PanelConfig {
  address: string;
  key: string;
  serviceType: string;
}

export function normalizeServerGroup(group: string | undefined): string {
  if (!group?.trim() || group === "default") {
    return "默认";
  }
  return group.trim();
}

export function connectionMatchesServerGroup(connection: Connection, groupName: string): boolean {
  return normalizeServerGroup(connection.group) === groupName;
}

export function connectionToServerEntry(connection: Connection): ServerEntry {
  const cfg = parsePanelConfig(connection);
  return {
    id: connection.id,
    name: connection.name,
    address: cfg.address,
    // 密钥在 Vault；业务路径通过 connectionId 回源，不依赖此处明文
    key: "",
    serviceType: cfg.serviceType,
    createdAt: connection.createdAt ?? Date.now(),
  };
}

export function serverEntryToConnection(entry: ServerEntry, group: string): Connection {
  const config: PanelConfig = {
    address: entry.address,
    key: entry.key,
    serviceType: entry.serviceType,
  };
  const now = Date.now();
  return {
    id: entry.id,
    kind: "panel",
    name: entry.name,
    group: normalizeServerGroup(group),
    envTag: "dev",
    config: JSON.stringify(config),
    createdAt: entry.createdAt ?? now,
    updatedAt: now,
  };
}
