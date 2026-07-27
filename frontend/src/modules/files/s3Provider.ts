/** S3 兼容存储供应商（连接配置 `provider` 字段）。 */
export type S3Provider = "aws" | "aliyun" | "tencent" | "qiniu";

export const S3_PROVIDERS: S3Provider[] = ["aliyun", "qiniu", "tencent", "aws"];

export function normalizeS3Provider(raw: unknown): S3Provider {
  if (raw === "aliyun" || raw === "tencent" || raw === "aws" || raw === "qiniu") {
    return raw;
  }
  return "aws";
}

/**
 * 按 Endpoint 域名识别供应商（优先于表单里可能选错的 provider 字段）。
 * 与后端 `s3_provider_of` 启发式保持一致。
 */
export function inferS3ProviderFromEndpoint(endpoint: string): S3Provider | null {
  const ep = endpoint.trim().toLowerCase();
  if (!ep) return null;
  if (ep.includes("qiniucs.com") || ep.includes(".qiniu.com")) return "qiniu";
  if (ep.includes("aliyuncs.com")) return "aliyun";
  if (ep.includes("myqcloud.com") || ep.includes("qcloud.com")) return "tencent";
  if (ep.includes("amazonaws.com") || ep.includes("amazonaws.com.cn")) return "aws";
  return null;
}

/** 解析连接上的供应商：Endpoint 域名优先，否则用 provider 字段。 */
export function resolveS3Provider(cfg: {
  provider?: unknown;
  endpoint?: string | null;
}): S3Provider {
  return (
    inferS3ProviderFromEndpoint(cfg.endpoint ?? "") ??
    normalizeS3Provider(cfg.provider)
  );
}

/** 按供应商生成默认 API endpoint（用户未填时后端也会再拼一次）。 */
export function defaultS3Endpoint(provider: S3Provider, region: string): string {
  const r = region.trim();
  if (!r) return "";
  switch (provider) {
    case "aliyun": {
      const ossRegion = r.startsWith("oss-") ? r : `oss-${r}`;
      return `https://${ossRegion}.aliyuncs.com`;
    }
    case "qiniu":
      return `https://s3.${r}.qiniucs.com`;
    case "tencent":
      return `https://cos.${r}.myqcloud.com`;
    case "aws":
    default:
      if (r === "us-east-1") return "https://s3.amazonaws.com";
      return `https://s3.${r}.amazonaws.com`;
  }
}

export function defaultS3Region(provider: S3Provider): string {
  switch (provider) {
    case "aliyun":
      return "oss-cn-beijing";
    case "qiniu":
      return "cn-north-1";
    case "tencent":
      return "ap-beijing";
    case "aws":
    default:
      return "us-east-1";
  }
}

export function s3RegionPlaceholder(provider: S3Provider): string {
  switch (provider) {
    case "aliyun":
      return "oss-cn-beijing";
    case "qiniu":
      return "cn-north-1";
    case "tencent":
      return "ap-beijing";
    case "aws":
    default:
      return "us-east-1";
  }
}

export function s3EndpointPlaceholder(provider: S3Provider): string {
  switch (provider) {
    case "aliyun":
      return "https://oss-cn-beijing.aliyuncs.com";
    case "qiniu":
      return "https://s3.cn-north-1.qiniucs.com";
    case "tencent":
      return "https://cos.ap-beijing.myqcloud.com";
    case "aws":
    default:
      return "https://s3.us-east-1.amazonaws.com";
  }
}
