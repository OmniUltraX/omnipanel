import type { Connection } from "../../../ipc/bindings";
import type { FileConfigJson } from "../../files/FileConnectionDialog";
import { defaultS3Endpoint, resolveS3Provider } from "../../files/s3Provider";
import { normalizeS3ApiEndpoint } from "../../files/s3PublicUrl";
import { saveFileConnection } from "../../files/fileApi";
import type { SshConfigJson } from "../panel/serverConnection";
import { parseCloudConfig, type CloudAccount } from "./cloudForm";

export type CloudLinkKind = "ecs" | "swas" | "oss";

/** 写入 SSH / S3 连接 config，用于反查「是否已加入」。 */
export type CloudResourceSource = {
  accountId: string;
  kind: CloudLinkKind;
  resourceId: string;
};

function parseSsh(conn: Connection): (SshConfigJson & { cloudSource?: CloudResourceSource }) | null {
  if (conn.kind !== "ssh") return null;
  try {
    return JSON.parse(conn.config || "{}") as SshConfigJson & {
      cloudSource?: CloudResourceSource;
    };
  } catch {
    return null;
  }
}

function parseFile(conn: Connection): (FileConfigJson & { cloudSource?: CloudResourceSource }) | null {
  if (conn.kind !== "file") return null;
  try {
    return JSON.parse(conn.config || "{}") as FileConfigJson & {
      cloudSource?: CloudResourceSource;
    };
  } catch {
    return null;
  }
}

function normalizeIp(raw: string | undefined | null): string {
  return (raw ?? "").trim();
}

/** 规范化阿里云 OSS region（`cn-hangzhou` → `oss-cn-hangzhou`）。 */
export function normalizeOssRegion(region: string): string {
  const r = region.trim();
  if (!r) return "oss-cn-hangzhou";
  if (r.startsWith("oss-")) return r;
  return `oss-${r}`;
}

export function findLinkedSshConnection(
  connections: Connection[],
  accountId: string,
  kind: "ecs" | "swas",
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
    const src = cfg.cloudSource;
    if (
      src &&
      src.accountId === accountId &&
      src.kind === kind &&
      src.resourceId === id
    ) {
      return conn;
    }
  }

  // 兼容手工添加的同 IP 主机
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
    const src = cfg.cloudSource;
    if (
      src &&
      src.accountId === accountId &&
      src.kind === "oss" &&
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
  kind: "ecs" | "swas",
  row: { id: string; name: string; publicIp?: string; privateIp?: string },
  save: (connection: Connection) => Promise<Connection | null>,
): Promise<Connection> {
  const host = pickInstanceHost(row.publicIp, row.privateIp);
  if (!host) {
    throw new Error("NO_HOST");
  }
  const cloudSource: CloudResourceSource = {
    accountId: account.id,
    kind,
    resourceId: row.id,
  };
  const now = Math.floor(Date.now() / 1000);
  const config: SshConfigJson & { cloudSource: CloudResourceSource } = {
    host,
    port: 22,
    user: "root",
    auth: { type: "password", password: "" },
    publicIp: normalizeIp(row.publicIp) || undefined,
    cloudSource,
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

  const region = normalizeOssRegion(row.region || account.regions[0] || "cn-hangzhou");
  const endpointRaw =
    (row.endpoint ?? "").trim() || defaultS3Endpoint("aliyun", region);
  const endpoint = normalizeS3ApiEndpoint(endpointRaw, bucket);
  const provider = resolveS3Provider({ provider: "aliyun", endpoint });

  const cloudSource: CloudResourceSource = {
    accountId: account.id,
    kind: "oss",
    resourceId: bucket,
  };

  const now = Math.floor(Date.now() / 1000);
  const cfg: FileConfigJson & { cloudSource: CloudResourceSource } = {
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
  };

  // 复用云账户 Vault 中的 Secret：file_save 会复制到 file-cred-{id}
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
