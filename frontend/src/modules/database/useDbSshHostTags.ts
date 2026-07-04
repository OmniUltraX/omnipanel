import { useEffect, useMemo, useState } from "react";
import type { Connection } from "../../ipc/bindings";
import { parseSshConfig } from "../server/panel/serverConnection";
import type { DbConnectionConfig } from "./api";
import { isConnectionEnabled } from "./api";
import {
  findSshConnectionForDbHost,
  getMatchedSshHostSync,
} from "./mysqlSlowQueryLog";

const LOCALHOST_ALIASES = new Set(["localhost", "127.0.0.1", "::1"]);

function isRemoteDbConnection(connection: Pick<DbConnectionConfig, "host" | "db_type" | "enabled">): boolean {
  if (!isConnectionEnabled(connection)) return false;
  const dbType = connection.db_type.toLowerCase();
  if (dbType === "sqlite" || dbType === "sqlite3") return false;
  const host = connection.host.trim();
  if (!host || LOCALHOST_ALIASES.has(host.toLowerCase())) return false;
  return true;
}

function buildLookupFingerprint(
  connections: DbConnectionConfig[],
  sshConnections: Connection[],
): string {
  const dbPart = connections
    .map((conn) => `${conn.id}:${conn.host}:${conn.db_type}:${conn.enabled === false ? 0 : 1}`)
    .join("|");
  const sshPart = sshConnections
    .map((conn) => {
      const cfg = conn.config;
      return `${conn.id}:${cfg}`;
    })
    .join("|");
  return `${dbPart}::${sshPart}`;
}

/** 数据库连接 id → 匹配到的 SSH Host，供侧栏 label 旁展示 tag。 */
export function useDbSshHostTags(
  connections: DbConnectionConfig[],
  sshConnections: Connection[],
): Record<string, string> {
  const lookupFingerprint = useMemo(
    () => buildLookupFingerprint(connections, sshConnections),
    [connections, sshConnections],
  );
  const [tagsByConnId, setTagsByConnId] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    const syncTags: Record<string, string> = {};
    const pending: DbConnectionConfig[] = [];

    for (const conn of connections) {
      if (!isRemoteDbConnection(conn)) continue;
      const syncHost = getMatchedSshHostSync(sshConnections, conn.host);
      if (syncHost) {
        syncTags[conn.id] = syncHost;
      } else {
        pending.push(conn);
      }
    }

    setTagsByConnId(syncTags);

    if (pending.length === 0) {
      return () => {
        cancelled = true;
      };
    }

    void (async () => {
      const nextTags = { ...syncTags };
      for (const conn of pending) {
        if (cancelled) return;
        const ssh = await findSshConnectionForDbHost(sshConnections, conn.host);
        if (!ssh) continue;
        const sshHost = parseSshConfig(ssh)?.host?.trim();
        if (sshHost) {
          nextTags[conn.id] = sshHost;
        }
      }
      if (!cancelled) {
        setTagsByConnId(nextTags);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [lookupFingerprint, connections, sshConnections]);

  return tagsByConnId;
}
