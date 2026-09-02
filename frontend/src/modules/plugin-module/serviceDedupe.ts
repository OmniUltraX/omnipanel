import type { ImportCandidate } from "@omnipanel/plugin-sdk";
import type { Connection } from "../../ipc/bindings";
import { candidateDedupeKey } from "../../lib/importCandidates";
import { servicePluginId } from "../../lib/moduleCapabilities";
import { connectionHostPort } from "./serviceConnections";

export function serviceRemoteId(host: string, port: number): string {
  return `${host}:${port}`;
}

export function buildServiceCandidate(
  pluginId: string,
  host: string,
  port: number,
  extras?: Record<string, unknown>,
): ImportCandidate {
  const remoteId = serviceRemoteId(host, port);
  return {
    pluginId,
    remoteId,
    remoteKind: "service",
    name: remoteId,
    config: {
      pluginId,
      host,
      port,
      ...extras,
    },
  };
}

export function isDuplicateService(
  connections: Connection[],
  pluginId: string,
  host: string,
  port: number,
): boolean {
  const remoteId = serviceRemoteId(host, port);
  const key = candidateDedupeKey({
    pluginId,
    remoteId,
    remoteKind: "service",
    name: remoteId,
  });
  return connections.some((conn) => {
    if (conn.kind !== "service") return false;
    try {
      const cfg = JSON.parse(conn.config || "{}") as {
        externalSource?: { pluginId?: string; accountId?: string; remoteId?: string };
      };
      if (cfg.externalSource?.pluginId && cfg.externalSource.remoteId) {
        return (
          candidateDedupeKey({
            pluginId: cfg.externalSource.pluginId,
            accountId: cfg.externalSource.accountId,
            remoteId: cfg.externalSource.remoteId,
            remoteKind: "",
            name: "",
          }) === key
        );
      }
    } catch {
      /* fall through */
    }
    return servicePluginId(conn.config) === pluginId && connectionHostPort(conn) === remoteId;
  });
}
