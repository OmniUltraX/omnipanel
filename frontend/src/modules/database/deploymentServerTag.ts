import type { Connection } from "@/ipc/bindings";
import {
  isMysqlConnectionInfoCapable,
  isRedisConnection,
  type DbConnectionConfig,
} from "./api";
import { findSshConnectionForDbHostSync } from "./mysqlSlowQueryLog";
import { readMysqlDeploymentCache } from "./mysqlDeploymentCache";
import { readRedisDeploymentCache } from "./redisDeploymentCache";

export const DEPLOYMENT_CACHE_UPDATED_EVENT = "omnipanel-deployment-cache-updated";

export type DetectedDeploymentInfo = {
  kind: "host" | "docker";
  serverName?: string;
  sshConnectionId?: string;
};

export function notifyDeploymentCacheUpdated(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DEPLOYMENT_CACHE_UPDATED_EVENT));
}

export function readConnectionDeploymentCache(
  connection: DbConnectionConfig,
): DetectedDeploymentInfo | null {
  if (isMysqlConnectionInfoCapable(connection)) {
    const info = readMysqlDeploymentCache(connection);
    if (!info || info.kind === "unknown") return null;
    return {
      kind: info.kind,
      serverName: info.serverName,
      sshConnectionId: info.sshConnectionId,
    };
  }
  if (isRedisConnection(connection)) {
    const info = readRedisDeploymentCache(connection);
    if (!info || info.kind === "unknown") return null;
    return {
      kind: info.kind,
      serverName: info.serverName,
      sshConnectionId: info.sshConnectionId,
    };
  }
  return null;
}

/** 已检测到 host/docker 部署时，解析用于侧栏展示的服务器名称。 */
export function resolveDeploymentServerTag(
  deployment: DetectedDeploymentInfo | null,
  sshConnections: Connection[],
  dbHost: string,
): string | null {
  if (!deployment) return null;

  if (deployment.serverName?.trim()) {
    return deployment.serverName.trim();
  }

  if (deployment.sshConnectionId) {
    const ssh = sshConnections.find((conn) => conn.id === deployment.sshConnectionId);
    if (ssh?.name?.trim()) {
      return ssh.name.trim();
    }
  }

  const ssh = findSshConnectionForDbHostSync(sshConnections, dbHost);
  return ssh?.name?.trim() ?? null;
}

export function buildDeploymentServerTagMap(
  connections: Array<{ config: DbConnectionConfig }>,
  sshConnections: Connection[],
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const conn of connections) {
    const deployment = readConnectionDeploymentCache(conn.config);
    const tag = resolveDeploymentServerTag(deployment, sshConnections, conn.config.host);
    if (tag) {
      map[conn.config.id] = tag;
    }
  }
  return map;
}
