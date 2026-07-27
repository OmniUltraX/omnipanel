import type { FileConfigJson } from "./FileConnectionDialog";

function normalizeBaseUrl(domain: string): string {
  const trimmed = domain.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, "");
  return `https://${trimmed.replace(/\/+$/, "")}`;
}

/**
 * 将虚拟主机风格 endpoint 规范为区域/服务 endpoint。
 * rust-s3 会再拼 `{bucket}.{host}`；若 endpoint 已含旧 bucket 子域，改桶后仍会打到旧桶。
 */
export function normalizeS3ApiEndpoint(endpoint: string, bucket: string): string {
  const raw = endpoint.trim().replace(/\/+$/, "");
  if (!raw) return "";
  const schemeMatch = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
  const scheme = schemeMatch?.[1] ?? "https";
  const afterScheme = schemeMatch ? raw.slice(schemeMatch[0].length) : raw;
  const hostPort = afterScheme.split("/")[0]?.trim() ?? "";
  if (!hostPort) return "";

  let host = hostPort;
  let port = "";
  const colon = hostPort.lastIndexOf(":");
  if (colon > 0) {
    const maybePort = hostPort.slice(colon + 1);
    if (/^\d+$/.test(maybePort)) {
      host = hostPort.slice(0, colon);
      port = maybePort;
    }
  }

  const normalizedHost = stripVirtualHostedBucketHost(host, bucket);
  return port
    ? `${scheme}://${normalizedHost}:${port}`
    : `${scheme}://${normalizedHost}`;
}

function stripVirtualHostedBucketHost(host: string, bucket: string): string {
  const dot = host.indexOf(".");
  if (dot <= 0 || dot === host.length - 1) return host;
  const first = host.slice(0, dot);
  const rest = host.slice(dot + 1);
  const firstL = first.toLowerCase();
  const restL = rest.toLowerCase();
  const bucketL = bucket.trim().toLowerCase();

  if (bucketL && firstL === bucketL) return rest;
  if ((restL.startsWith("oss-") || restL.startsWith("oss.")) && restL.includes("aliyuncs.com")) {
    return rest;
  }
  if (
    restL === "s3.amazonaws.com"
    || (restL.startsWith("s3.") && restL.endsWith(".amazonaws.com"))
    || (restL.startsWith("s3-") && restL.endsWith(".amazonaws.com"))
  ) {
    return rest;
  }
  if (restL.startsWith("cos.") && restL.includes("myqcloud.com")) {
    return rest;
  }
  // 七牛 Kodo S3：*.s3.*.qiniucs.com
  if (restL.startsWith("s3.") && restL.includes("qiniucs.com")) {
    return rest;
  }
  return host;
}

/** 保留路径分隔符，仅编码各段。 */
function encodeObjectKey(key: string): string {
  const normalized = key.replace(/^\/+/, "");
  if (!normalized) return "";
  return normalized.split("/").map(encodeURIComponent).join("/");
}

export function parseFileConfigJson(config: string): FileConfigJson {
  try {
    return JSON.parse(config || "{}") as FileConfigJson;
  } catch {
    return { protocol: "local" };
  }
}

/** 根据 S3 连接配置与对象 key 生成可分享的公开 URL。 */
export function buildS3PublicUrl(cfg: FileConfigJson, objectKey: string): string | null {
  if (!objectKey || objectKey.endsWith("/")) return null;

  const key = objectKey.replace(/^\/+/, "");
  const encodedKey = encodeObjectKey(key);
  if (!encodedKey) return null;

  const publicBase = normalizeBaseUrl(cfg.publicDomain ?? "");
  if (publicBase) {
    return `${publicBase}/${encodedKey}`;
  }

  const bucket = cfg.bucket?.trim() ?? "";
  const endpoint = normalizeBaseUrl(
    bucket ? normalizeS3ApiEndpoint(cfg.endpoint ?? "", bucket) : (cfg.endpoint ?? ""),
  );
  if (endpoint && bucket) {
    try {
      const url = new URL(endpoint);
      const host = url.host;
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host.split(":")[0] ?? "")) {
        return `${endpoint}/${encodeURIComponent(bucket)}/${encodedKey}`;
      }
      return `${url.protocol}//${bucket}.${host}/${encodedKey}`;
    } catch {
      return `${endpoint}/${encodeURIComponent(bucket)}/${encodedKey}`;
    }
  }

  const region = cfg.region?.trim() ?? "";
  if (bucket && region) {
    if (region === "us-east-1") {
      return `https://${bucket}.s3.amazonaws.com/${encodedKey}`;
    }
    return `https://${bucket}.s3.${region}.amazonaws.com/${encodedKey}`;
  }

  return null;
}
