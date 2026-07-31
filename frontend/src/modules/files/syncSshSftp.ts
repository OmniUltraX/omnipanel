import type { Connection } from "../../ipc/bindings";
import { mergeConnectionTags, userConnectionTags } from "../tags/tagKinds";
import { saveFileConnection } from "./fileApi";

export type SyncSshSftpResult = {
  added: number;
  updated: number;
  skipped: number;
};

type SftpFileConfig = {
  protocol?: string;
  rootPath?: string;
  sshConnectionId?: string;
};

function parseSftpConfig(conn: Connection): SftpFileConfig | null {
  if (conn.kind !== "file") return null;
  try {
    const cfg = JSON.parse(conn.config || "{}") as SftpFileConfig;
    if (cfg.protocol !== "sftp") return null;
    return cfg;
  } catch {
    return null;
  }
}

function linkedSshId(conn: Connection): string | null {
  const cfg = parseSftpConfig(conn);
  const id = cfg?.sshConnectionId?.trim();
  return id || null;
}

function buildSftpFromSsh(ssh: Connection): Connection {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: "",
    kind: "file",
    name: ssh.name,
    group: "远程连接",
    envTag: ssh.envTag ?? "unknown",
    tags: mergeConnectionTags(userConnectionTags(ssh.tags), undefined),
    config: JSON.stringify({
      protocol: "sftp",
      rootPath: "/",
      sshConnectionId: ssh.id,
    } satisfies SftpFileConfig),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 将 SSH 主机同步为文件管理中的 SFTP 连接（按 sshConnectionId 关联）。
 * - 缺失则新建
 * - 已存在则同步名称 / 环境标签
 */
export async function syncSshSftpConnections(
  connections: Connection[],
): Promise<SyncSshSftpResult> {
  const sshList = connections.filter((c) => c.kind === "ssh");
  const fileList = connections.filter((c) => c.kind === "file");

  const linkedBySshId = new Map<string, Connection>();
  for (const file of fileList) {
    const sshId = linkedSshId(file);
    if (!sshId || linkedBySshId.has(sshId)) continue;
    linkedBySshId.set(sshId, file);
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const ssh of sshList) {
    const existing = linkedBySshId.get(ssh.id);
    if (!existing) {
      await saveFileConnection(buildSftpFromSsh(ssh), null);
      added += 1;
      continue;
    }

    const nameChanged = existing.name !== ssh.name;
    const envChanged = (existing.envTag ?? "unknown") !== (ssh.envTag ?? "unknown");
    if (!nameChanged && !envChanged) {
      skipped += 1;
      continue;
    }

    const now = Math.floor(Date.now() / 1000);
    await saveFileConnection(
      {
        ...existing,
        name: ssh.name,
        envTag: ssh.envTag ?? existing.envTag ?? "unknown",
        updatedAt: now,
      },
      null,
    );
    updated += 1;
  }

  return { added, updated, skipped };
}
