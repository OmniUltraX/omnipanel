import type { Connection, SshKeyInfo } from "../../../../ipc/bindings";
import { parseSshConfig } from "../../panel/serverConnection";

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, "/");
}

function pathMatchesKey(keyPath: string, key: SshKeyInfo): boolean {
  const normalized = normalizePath(keyPath);
  if (!normalized || normalized === "auto") {
    return false;
  }
  const name = key.name.trim();
  const sourcePath = normalizePath(key.path);
  if (normalized === name) {
    return true;
  }
  if (sourcePath && normalized === sourcePath) {
    return true;
  }
  const base = normalized.split("/").pop();
  return base === name;
}

/** 统计每个密钥库条目被多少 SSH 主机连接引用（keyId 或遗留 keyPath）。 */
export function buildSshKeyUsageCounts(
  keys: SshKeyInfo[],
  connections: Connection[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) {
    counts.set(key.id, 0);
  }

  for (const conn of connections) {
    if (conn.kind !== "ssh") {
      continue;
    }
    const cfg = parseSshConfig(conn);
    if (!cfg || cfg.auth.type !== "privateKey") {
      continue;
    }

    const keyId = cfg.auth.keyId?.trim();
    if (keyId && counts.has(keyId)) {
      counts.set(keyId, (counts.get(keyId) ?? 0) + 1);
      continue;
    }

    const keyPath = cfg.auth.keyPath?.trim();
    if (!keyPath) {
      continue;
    }

    for (const key of keys) {
      if (pathMatchesKey(keyPath, key)) {
        counts.set(key.id, (counts.get(key.id) ?? 0) + 1);
        break;
      }
    }
  }

  return counts;
}
