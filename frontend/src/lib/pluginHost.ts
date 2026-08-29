import type { ImportCandidate, PluginHost } from "@omnipanel/plugin-sdk";
import { commands, type Connection, type DbConnectionConfig } from "../ipc/bindings";
import { formatIpcError, unwrapCommand } from "../ipc/result";
import { getHostSelection } from "./hostSelection";
import { useConnectionStore } from "../stores/connectionStore";
import { findSidebarFolder } from "./importGroups";
import { useDbConnectionListStore } from "../stores/dbConnectionListStore";
import { useDbSchemaConnectionLayoutStore } from "../stores/dbSchemaConnectionLayoutStore";
import {
  sshSidebarConnectionNodeKey,
  useSshSidebarTreeStore,
} from "../stores/sshSidebarTreeStore";
import { usePluginOverlayStore } from "../stores/pluginOverlayStore";
import { candidateDedupeKey } from "./importCandidates";
import { panelCandidateMatches } from "../modules/server/panel/panelPlugin";
import { ensureEngineForDbType } from "../modules/database/ensureCatalogEngines";

/** 内核发现（非插件）写入时跳过插件权限闸。 */
export const KERNEL_DOCKER_PLUGIN_ID = "omni.host.docker";

function isKernelHost(pluginId: string): boolean {
  return pluginId === KERNEL_DOCKER_PLUGIN_ID || pluginId.startsWith("omni.host.");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function findExistingCandidate(
  connections: Connection[],
  candidate: ImportCandidate,
): Connection | undefined {
  const key = candidateDedupeKey(candidate);
  return connections.find((conn) => {
    try {
      const cfg = JSON.parse(conn.config || "{}") as {
        externalSource?: { pluginId?: string; accountId?: string; remoteId?: string };
        sshConnectionId?: string;
        boundSshConnectionId?: string;
        serviceType?: string;
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
      if (candidate.remoteKind === "panel" && conn.kind === "panel") {
        return panelCandidateMatches(conn, candidate);
      }
      if (candidate.remoteKind === "docker" && conn.kind === "docker") {
        return cfg.boundSshConnectionId === candidate.accountId;
      }
    } catch {
      return false;
    }
    return false;
  });
}

function withExternalSource(
  config: Record<string, unknown>,
  candidate: ImportCandidate,
): Record<string, unknown> {
  return {
    ...config,
    externalSource: {
      pluginId: candidate.pluginId,
      accountId: candidate.accountId,
      remoteId: candidate.remoteId,
      remoteKind: candidate.remoteKind,
    },
  };
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function sshAuthFromCandidate(cfg: Record<string, unknown>): Record<string, unknown> {
  const keyId = asString(cfg.keyId);
  if (keyId) {
    return {
      type: "privateKey",
      keyPath: "auto",
      pem: null,
      keyId,
      passphrase: asString(cfg.passphrase) || null,
    };
  }
  const password = asString(cfg.password);
  return { type: "password", password };
}

async function saveConnection(draft: Connection): Promise<Connection> {
  const saved = await useConnectionStore.getState().save(draft);
  if (saved?.id) return saved;
  const detail = useConnectionStore.getState().error;
  throw new Error(detail ? formatIpcError(detail) : "保存连接失败");
}

function placeImportedDbConnection(connId: string, folderPath: string): void {
  const store = useDbSchemaConnectionLayoutStore.getState();
  const trimmed = folderPath.trim();
  if (!trimmed) {
    store.setConnectionParent(connId, null);
    return;
  }
  const found = findSidebarFolder(store.folders, trimmed);
  const folderId = found?.id ?? store.addFolder(null, trimmed).id;
  store.setConnectionParent(connId, folderId);
}

function placeImportedSshConnection(connId: string, folderPath: string): void {
  const store = useSshSidebarTreeStore.getState();
  store.ensureConnectionListed(connId);
  const trimmed = folderPath.trim();
  if (!trimmed) {
    store.moveNode({ nodeKey: sshSidebarConnectionNodeKey(connId), targetParentId: null });
    return;
  }
  const found = findSidebarFolder(store.folders, trimmed);
  const folderId = found?.id ?? store.createFolder(trimmed, null);
  store.moveNode({ nodeKey: sshSidebarConnectionNodeKey(connId), targetParentId: folderId });
}

export function importExtTag(candidate: ImportCandidate): string {
  return `ext:${candidate.pluginId}:${candidate.accountId ?? ""}:${candidate.remoteId}`;
}

function findExistingDbConnection(
  list: DbConnectionConfig[],
  candidate: ImportCandidate,
  host: string,
  port: number,
  user: string,
  dbType: string,
): DbConnectionConfig | undefined {
  const ext = importExtTag(candidate);
  return (
    list.find((item) => (item.tags ?? []).includes(ext)) ??
    list.find(
      (item) =>
        item.db_type === dbType &&
        item.host === host &&
        item.port === port &&
        item.user === user &&
        item.name === candidate.name,
    )
  );
}

const DB_IMPORT_KINDS: Record<string, { dbType: string; defaultPort: number }> = {
  mysql: { dbType: "mysql", defaultPort: 3306 },
  postgres: { dbType: "postgresql", defaultPort: 5432 },
  redis: { dbType: "redis", defaultPort: 6379 },
  mongodb: { dbType: "mongodb", defaultPort: 27017 },
  clickhouse: { dbType: "clickhouse", defaultPort: 8123 },
  sqlserver: { dbType: "sqlserver", defaultPort: 1433 },
  qdrant: { dbType: "qdrant", defaultPort: 6333 },
  dameng: { dbType: "dameng", defaultPort: 5236 },
  cassandra: { dbType: "cassandra", defaultPort: 9042 },
  neo4j: { dbType: "neo4j", defaultPort: 7687 },
};

async function upsertDbCandidate(
  candidate: ImportCandidate,
  cfg: Record<string, unknown>,
): Promise<void> {
  const mapped = DB_IMPORT_KINDS[candidate.remoteKind];
  if (!mapped) throw new Error(`不支持导入类型: ${candidate.remoteKind}`);
  const dbType = mapped.dbType;
  const host = asString(cfg.host);
  const port = asNumber(cfg.port, mapped.defaultPort);
  const user = asString(cfg.user);
  const password = asString(cfg.password);
  const group = asString(cfg.importGroup);
  const list = await unwrapCommand(commands.dbListConnections());
  const existing = findExistingDbConnection(list, candidate, host, port, user, dbType);
  const tags = Array.from(
    new Set([...(existing?.tags ?? []), ...asStringList(cfg.importTags), importExtTag(candidate)]),
  );
  void ensureEngineForDbType(dbType);
  const saved = await unwrapCommand(
    commands.dbSaveConnection({
      id: existing?.id ?? "",
      name: candidate.name,
      db_type: dbType,
      host,
      port,
      user,
      ...(password ? { password } : {}),
      database: asString(cfg.database) || existing?.database || "",
      ssl: existing?.ssl ?? false,
      status: existing?.status ?? "unknown",
      enabled: existing?.enabled ?? true,
      tags,
      group: existing?.group || group || "默认",
    }),
  );
  if (saved.id) placeImportedDbConnection(saved.id, group);
  await useDbConnectionListStore.getState().refresh();
}

async function upsertCandidateConnection(candidate: ImportCandidate): Promise<void> {
  const cfg = asRecord(candidate.config);
  const existing = findExistingCandidate(useConnectionStore.getState().connections, candidate);
  const ts = nowSec();

  if (candidate.remoteKind === "ssh") {
    const saved = await saveConnection({
      id: existing?.id ?? "",
      kind: "ssh",
      name: candidate.name,
      group: existing?.group || asString(cfg.importGroup) || "默认",
      envTag: existing?.envTag || "unknown",
      tags: Array.from(new Set([...(existing?.tags ?? []), ...asStringList(cfg.importTags)])),
      config: JSON.stringify(
        withExternalSource(
          {
            host: asString(cfg.host),
            port: asNumber(cfg.port, 22),
            user: asString(cfg.user, "root"),
            auth: sshAuthFromCandidate(cfg),
          },
          candidate,
        ),
      ),
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    });
    placeImportedSshConnection(saved.id, asString(cfg.importGroup));
    return;
  }

  if (candidate.remoteKind === "panel") {
    await saveConnection({
      id: existing?.id ?? "",
      kind: "panel",
      name: candidate.name,
      group: existing?.group || asString(cfg.importGroup, "默认") || "默认",
      envTag: existing?.envTag || "dev",
      tags: Array.from(new Set([...(existing?.tags ?? []), ...asStringList(cfg.importTags)])),
      config: JSON.stringify(
        withExternalSource(
          {
            address: asString(cfg.address),
            key: asString(cfg.key),
            serviceType: asString(cfg.serviceType, candidate.pluginId),
            sshConnectionId: asString(cfg.sshConnectionId, candidate.accountId),
          },
          candidate,
        ),
      ),
      credentialRef: existing?.id ? `panel-key-${existing.id}` : null,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    });
    return;
  }

  if (candidate.remoteKind === "docker") {
    const dockerCfg = asRecord(cfg.dockerConfig) ;
    await saveConnection({
      id: existing?.id || asString(cfg.id, `docker-bound-${candidate.accountId ?? candidate.remoteId}`),
      kind: "docker",
      name: candidate.name,
      group: existing?.group || asString(cfg.importGroup, "默认") || "默认",
      envTag: existing?.envTag || "unknown",
      tags: Array.from(new Set([...(existing?.tags ?? []), ...asStringList(cfg.importTags)])),
      config: JSON.stringify(withExternalSource({ ...dockerCfg }, candidate)),
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
    });
    return;
  }

  if (candidate.remoteKind in DB_IMPORT_KINDS) {
    await upsertDbCandidate(candidate, cfg);
    return;
  }

  throw new Error(`不支持导入类型: ${candidate.remoteKind}`);
}

export async function requirePluginPermission(
  pluginId: string,
  permission: string,
): Promise<void> {
  if (isKernelHost(pluginId)) return;
  await unwrapCommand(commands.pluginRequirePermission(pluginId, permission));
}

export function createPluginHost(pluginId: string): PluginHost {
  return {
    selection: {
      get: getHostSelection,
    },
    connections: {
      upsert: async (candidate: ImportCandidate) => {
        await requirePluginPermission(pluginId, "connections:write");
        if (candidate.pluginId !== pluginId && !isKernelHost(pluginId)) {
          throw new Error("候选 pluginId 与当前 Host 不一致");
        }
        await upsertCandidateConnection(candidate);
      },
    },
    invoke: async (method, args) =>
      unwrapCommand(commands.pluginInvoke(pluginId, method, (args ?? null) as never)),
    ui: {
      overlay: {
        show: ({ id, title, body }) =>
          usePluginOverlayStore.getState().show({ id, pluginId, title, body }),
        hide: (id) => usePluginOverlayStore.getState().hide(id),
      },
    },
  };
}
