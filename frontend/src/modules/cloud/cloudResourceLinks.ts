import type { ExternalSource } from "@omnipanel/plugin-sdk";
import type { Connection } from "../../ipc/bindings";
import type { FileConfigJson } from "../files/FileConnectionDialog";
import { defaultS3Endpoint, resolveS3Provider } from "../files/s3Provider";
import { normalizeS3ApiEndpoint } from "../files/s3PublicUrl";
import { saveFileConnection } from "../files/fileApi";
import type { SshConfigJson } from "../server/panel/serverConnection";
import { isTencentCloud, parseCloudConfig, PLUGIN_ID_ALIYUN, type CloudAccount } from "./cloudForm";

export type CloudLinkKind =
  | "compute"
  | "compute.lite"
  | "objectStorage"
  | "database"
  | "ecs"
  | "swas"
  | "oss"
  | "rds";

function toCapabilityId(kind: string): string {
  if (kind === "ecs") return "compute";
  if (kind === "swas") return "compute.lite";
  if (kind === "oss") return "objectStorage";
  if (kind === "rds") return "database";
  return kind;
}

export function cloudRemoteKindAliases(kind: string): string[] {
  const cap = toCapabilityId(kind);
  if (cap === "compute") return ["compute", "ecs"];
  if (cap === "compute.lite") return ["compute.lite", "swas"];
  if (cap === "objectStorage") return ["objectStorage", "oss"];
  if (cap === "database") return ["database", "rds"];
  return [kind];
}

function pluginIdOf(account: CloudAccount): string {
  return account.pluginId || PLUGIN_ID_ALIYUN;
}

export type CloudResourceSource = {
  accountId: string;
  kind: string;
  resourceId: string;
};

function toExternalSource(account: CloudAccount, src: CloudResourceSource): ExternalSource {
  return {
    pluginId: pluginIdOf(account),
    accountId: src.accountId,
    remoteId: src.resourceId,
    remoteKind: toCapabilityId(src.kind),
  };
}

function readLinkedSource(cfg: {
  externalSource?: ExternalSource;
  cloudSource?: CloudResourceSource;
}): CloudResourceSource | null {
  if (cfg.externalSource?.remoteId) {
    return {
      accountId: cfg.externalSource.accountId ?? "",
      kind: cfg.externalSource.remoteKind,
      resourceId: cfg.externalSource.remoteId,
    };
  }
  return cfg.cloudSource ?? null;
}

function kindsMatch(stored: string, wanted: string): boolean {
  const aliases = new Set(cloudRemoteKindAliases(wanted));
  return aliases.has(stored) || aliases.has(toCapabilityId(stored));
}

function parseSsh(conn: Connection): (SshConfigJson & {
  cloudSource?: CloudResourceSource;
  externalSource?: ExternalSource;
}) | null {
  if (conn.kind !== "ssh") return null;
  try {
    return JSON.parse(conn.config || "{}") as SshConfigJson & {
      cloudSource?: CloudResourceSource;
      externalSource?: ExternalSource;
    };
  } catch {
    return null;
  }
}

function parseFile(conn: Connection): (FileConfigJson & {
  cloudSource?: CloudResourceSource;
  externalSource?: ExternalSource;
}) | null {
  if (conn.kind !== "file") return null;
  try {
    return JSON.parse(conn.config || "{}") as FileConfigJson & {
      cloudSource?: CloudResourceSource;
      externalSource?: ExternalSource;
    };
  } catch {
    return null;
  }
}

function normalizeIp(raw: string | undefined | null): string {
  return (raw ?? "").trim();
}

export function normalizeOssRegion(region: string): string {
  const r = region.trim();
  if (!r) return "oss-cn-hangzhou";
  if (r.startsWith("oss-")) return r;
  return `oss-${r}`;
}

export function findLinkedSshConnection(
  connections: Connection[],
  accountId: string,
  kind: string,
  instanceId: string,
  publicIp?: string,
  privateIp?: string,
): Connection | null {
  const id = instanceId.trim();
  const pub = normalizeIp(publicIp);
  const priv = normalizeIp(privateIp);

  for (const conn of connections) {
    if (conn.kind !== "ssh") continue;
    const cfg = parseSsh(conn);
    if (!cfg) continue;
    const src = readLinkedSource(cfg);
    if (src && src.accountId === accountId && kindsMatch(src.kind, kind) && src.resourceId === id) {
      return conn;
    }
  }

  for (const conn of connections) {
    if (conn.kind !== "ssh") continue;
    const cfg = parseSsh(conn);
    if (!cfg) continue;
    const host = normalizeIp(cfg.host);
    if (!host) continue;
    if ((pub && host === pub) || (priv && host === priv)) {
      return conn;
    }
  }
  return null;
}

export function findLinkedOssFileConnection(
  connections: Connection[],
  accountId: string,
  bucket: string,
): Connection | null {
  const name = bucket.trim();
  if (!name) return null;

  for (const conn of connections) {
    if (conn.kind !== "file") continue;
    const cfg = parseFile(conn);
    if (!cfg || cfg.protocol !== "s3") continue;
    const src = readLinkedSource(cfg);
    if (
      src &&
      src.accountId === accountId &&
      kindsMatch(src.kind, "objectStorage") &&
      src.resourceId === name
    ) {
      return conn;
    }
  }

  for (const conn of connections) {
    if (conn.kind !== "file") continue;
    const cfg = parseFile(conn);
    if (!cfg || cfg.protocol !== "s3") continue;
    if ((cfg.bucket ?? "").trim() === name) {
      return conn;
    }
  }
  return null;
}

export function pickInstanceHost(publicIp?: string, privateIp?: string): string | null {
  const pub = normalizeIp(publicIp);
  if (pub) return pub;
  const priv = normalizeIp(privateIp);
  if (priv) return priv;
  return null;
}

export async function addCloudInstanceToSsh(
  account: CloudAccount,
  kind: string,
  row: { id: string; name: string; publicIp?: string; privateIp?: string },
  save: (connection: Connection) => Promise<Connection | null>,
): Promise<Connection> {
  const host = pickInstanceHost(row.publicIp, row.privateIp);
  if (!host) {
    throw new Error("NO_HOST");
  }
  const cloudSource: CloudResourceSource = {
    accountId: account.id,
    kind: toCapabilityId(kind),
    resourceId: row.id,
  };
  const now = Math.floor(Date.now() / 1000);
  const config: SshConfigJson & {
    cloudSource: CloudResourceSource;
    externalSource: ExternalSource;
  } = {
    host,
    port: 22,
    user: "root",
    auth: { type: "password", password: "" },
    publicIp: normalizeIp(row.publicIp) || undefined,
    cloudSource,
    externalSource: toExternalSource(account, cloudSource),
  };
  const draft: Connection = {
    id: "",
    kind: "ssh",
    name: (row.name || row.id).trim() || host,
    group: "云主机",
    envTag: "unknown",
    tags: [],
    config: JSON.stringify(config),
    createdAt: now,
    updatedAt: now,
  };
  const saved = await save(draft);
  if (!saved?.id) throw new Error("SAVE_FAILED");
  return saved;
}

export async function addCloudOssToFile(
  account: CloudAccount,
  cloudConnection: Connection,
  row: { id: string; name: string; region?: string; endpoint?: string },
): Promise<Connection> {
  const bucket = (row.name || row.id).trim();
  if (!bucket) throw new Error("NO_BUCKET");

  const cloudCfg = parseCloudConfig(cloudConnection);
  const accessKey = (cloudCfg.accessKeyId ?? "").trim();
  if (!accessKey) throw new Error("NO_AK");

  const tencent = isTencentCloud(account.pluginId);
  const rawRegion = row.region || account.regions[0] || (tencent ? "ap-guangzhou" : "cn-hangzhou");
  const region = tencent ? rawRegion.replace(/^oss-/, "") : normalizeOssRegion(rawRegion);
  const providerHint = tencent ? "tencent" : "aliyun";
  const endpointRaw = (row.endpoint ?? "").trim() || defaultS3Endpoint(providerHint, region);
  const endpoint = normalizeS3ApiEndpoint(endpointRaw, bucket);
  const provider = resolveS3Provider({ provider: providerHint, endpoint });

  const cloudSource: CloudResourceSource = {
    accountId: account.id,
    kind: "objectStorage",
    resourceId: bucket,
  };

  const now = Math.floor(Date.now() / 1000);
  const cfg: FileConfigJson & {
    cloudSource: CloudResourceSource;
    externalSource: ExternalSource;
  } = {
    protocol: "s3",
    provider,
    bucket,
    region,
    endpoint,
    publicDomain: "",
    prefix: "",
    accessKey,
    rootPath: "/",
    cloudSource,
    externalSource: toExternalSource(account, cloudSource),
  };

  const draft: Connection = {
    id: "",
    kind: "file",
    name: bucket,
    group: "S3 存储",
    envTag: "unknown",
    tags: [],
    config: JSON.stringify(cfg),
    credentialRef: cloudConnection.credentialRef ?? `cloud-secret-${account.id}`,
    createdAt: now,
    updatedAt: now,
  };

  return saveFileConnection(draft, null);
}

export function rdsEngineToDbType(engine: string): string {
  const value = engine.trim().toLowerCase();
  if (value.includes("postgres")) return "postgres";
  if (value.includes("sqlserver") || value.includes("mssql")) return "sqlserver";
  if (value.includes("redis") || value.includes("tair") || value.includes("kvstore")) return "redis";
  if (value.includes("mariadb")) return "mysql";
  if (value.includes("mysql")) return "mysql";
  return "mysql";
}

export async function addCloudRdsToDatabase(
  _account: CloudAccount,
  row: { id: string; name: string; engine?: string; host?: string; port?: string },
): Promise<void> {
  const host = (row.host ?? "").trim();
  if (!host) throw new Error("NO_HOST");
  const dbType = rdsEngineToDbType(row.engine ?? "");
  const port = Number.parseInt(row.port || "", 10);
  const { saveConnection } = await import("../database/api");
  await saveConnection({
    id: "",
    name: (row.name || row.id).trim() || host,
    db_type: dbType,
    host,
    port: Number.isFinite(port) && port > 0 ? port : dbType === "postgres" ? 5432 : dbType === "redis" ? 6379 : 3306,
    user: dbType === "postgres" ? "postgres" : "root",
    password: "",
    database: "",
    ssl: false,
    status: "unknown",
    enabled: true,
    group: "云数据库",
  });
}

export function listLinkedCloudSsh(connections: Connection[], accountId: string): Connection[] {
  return connections.filter((conn) => {
    if (conn.kind !== "ssh") return false;
    const cfg = parseSsh(conn);
    return cfg ? readLinkedSource(cfg)?.accountId === accountId : false;
  });
}

export function listLinkedCloudFiles(connections: Connection[], accountId: string): Connection[] {
  return connections.filter((conn) => {
    if (conn.kind !== "file") return false;
    const cfg = parseFile(conn);
    return cfg ? readLinkedSource(cfg)?.accountId === accountId : false;
  });
}
