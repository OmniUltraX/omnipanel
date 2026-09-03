import type { Connection } from "../../ipc/bindings";
import { resolveLegacyPluginId } from "../../lib/pluginManifests";

export type CloudFormData = {
  name: string;
  pluginId: string;
  regions: string[];
  accessKeyId: string;
  accessKeySecret: string;
  remark: string;
};

export const PLUGIN_ID_ALIYUN = "omni.cloud.aliyun";
export const PLUGIN_ID_TENCENT = "omni.cloud.tencent";

export const EMPTY_CLOUD_FORM: CloudFormData = {
  name: "",
  pluginId: PLUGIN_ID_ALIYUN,
  regions: [],
  accessKeyId: "",
  accessKeySecret: "",
  remark: "",
};

export function isTencentCloud(pluginId: string | null | undefined): boolean {
  const id = (pluginId ?? "").trim();
  return id === PLUGIN_ID_TENCENT || id === "tencent" || id === "qcloud";
}

export function cloudBrandKind(pluginId: string | null | undefined): "aliyun" | "tencent" {
  return isTencentCloud(pluginId) ? "tencent" : "aliyun";
}

/** 常用阿里云 Region（添加账户时可多选）。 */
export const ALIYUN_REGION_OPTIONS: { value: string; label: string }[] = [
  { value: "cn-hangzhou", label: "华东1（杭州）" },
  { value: "cn-shanghai", label: "华东2（上海）" },
  { value: "cn-qingdao", label: "华北1（青岛）" },
  { value: "cn-beijing", label: "华北2（北京）" },
  { value: "cn-zhangjiakou", label: "华北3（张家口）" },
  { value: "cn-huhehaote", label: "华北5（呼和浩特）" },
  { value: "cn-wulanchabu", label: "华北6（乌兰察布）" },
  { value: "cn-shenzhen", label: "华南1（深圳）" },
  { value: "cn-heyuan", label: "华南2（河源）" },
  { value: "cn-guangzhou", label: "华南3（广州）" },
  { value: "cn-chengdu", label: "西南1（成都）" },
  { value: "cn-hongkong", label: "中国香港" },
  { value: "cn-wuhan", label: "华中1（武汉）" },
  { value: "cn-nanjing", label: "华东5（南京）" },
  { value: "cn-fuzhou", label: "华东6（福州）" },
  { value: "ap-southeast-1", label: "新加坡" },
  { value: "ap-southeast-3", label: "马来西亚（吉隆坡）" },
  { value: "ap-northeast-1", label: "日本（东京）" },
  { value: "us-west-1", label: "美国（硅谷）" },
  { value: "us-east-1", label: "美国（弗吉尼亚）" },
  { value: "eu-central-1", label: "德国（法兰克福）" },
];

/** 常用腾讯云 Region。 */
export const TENCENT_REGION_OPTIONS: { value: string; label: string }[] = [
  { value: "ap-guangzhou", label: "华南（广州）" },
  { value: "ap-shanghai", label: "华东（上海）" },
  { value: "ap-nanjing", label: "华东（南京）" },
  { value: "ap-beijing", label: "华北（北京）" },
  { value: "ap-chengdu", label: "西南（成都）" },
  { value: "ap-chongqing", label: "西南（重庆）" },
  { value: "ap-hongkong", label: "中国香港" },
  { value: "ap-singapore", label: "新加坡" },
  { value: "ap-jakarta", label: "雅加达" },
  { value: "ap-seoul", label: "首尔" },
  { value: "ap-tokyo", label: "东京" },
  { value: "ap-bangkok", label: "曼谷" },
  { value: "na-siliconvalley", label: "硅谷" },
  { value: "na-ashburn", label: "弗吉尼亚" },
  { value: "eu-frankfurt", label: "法兰克福" },
  { value: "eu-moscow", label: "莫斯科" },
];

export function cloudRegionOptions(pluginId: string | null | undefined): { value: string; label: string }[] {
  return isTencentCloud(pluginId) ? TENCENT_REGION_OPTIONS : ALIYUN_REGION_OPTIONS;
}

const REGION_LABEL_MAP = new Map(
  [...ALIYUN_REGION_OPTIONS, ...TENCENT_REGION_OPTIONS].map((r) => [r.value, r.label]),
);

export function cloudRegionLabel(regionId: string, localName?: string): string {
  const id = regionId.trim();
  if (!id) return "—";
  const apiName = localName?.trim();
  if (apiName && apiName !== id) return `${apiName}（${id}）`;
  const label = REGION_LABEL_MAP.get(id);
  return label ? `${label}（${id}）` : id;
}

/** 概览展示用，避免把完整 AccessKeyId 铺在工作台。 */
export function maskCloudAccessKey(accessKeyId: string): string {
  const value = accessKeyId.trim();
  if (!value) return "—";
  if (value.length <= 10) return "••••";
  return `${value.slice(0, 6)}••••${value.slice(-4)}`;
}

export function normalizeCloudRegions(regions: unknown, legacyRegion?: unknown): string[] {
  const fromList = Array.isArray(regions)
    ? regions
        .filter((r): r is string => typeof r === "string")
        .map((r) => r.trim())
        .filter(Boolean)
    : [];
  const legacy =
    typeof legacyRegion === "string" && legacyRegion.trim() ? [legacyRegion.trim()] : [];
  const merged = [...fromList, ...legacy];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of merged) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export interface CloudConfigJson {
  pluginId?: string;
  provider?: string;
  /** @deprecated 兼容旧配置，读取时并入 regions */
  region?: string;
  regions?: string[];
  accessKeyId?: string;
  accessKeySecret?: string;
  remark?: string;
}

export function parseCloudConfig(connection: Connection): CloudConfigJson {
  try {
    return JSON.parse(connection.config || "{}") as CloudConfigJson;
  } catch {
    return {};
  }
}

export function resolveCloudPluginId(cfg: CloudConfigJson): string {
  return (
    resolveLegacyPluginId(cfg.pluginId) ??
    resolveLegacyPluginId(cfg.provider) ??
    PLUGIN_ID_ALIYUN
  );
}

/** 账户级厂商控制台首页；资源详情不再放「打开控制台」按钮。 */
export function cloudAccountConsoleUrl(pluginId: string): string | null {
  const id = pluginId.trim() || PLUGIN_ID_ALIYUN;
  if (id === PLUGIN_ID_ALIYUN || id === "aliyun") {
    return "https://home.console.aliyun.com/";
  }
  if (isTencentCloud(id)) {
    return "https://console.cloud.tencent.com/";
  }
  return null;
}

export function cloudConnectionToForm(connection: Connection): CloudFormData {
  const cfg = parseCloudConfig(connection);
  const regions = normalizeCloudRegions(cfg.regions, cfg.region);
  return {
    name: connection.name,
    pluginId: resolveCloudPluginId(cfg),
    regions,
    accessKeyId: cfg.accessKeyId?.trim() || "",
    accessKeySecret: "",
    remark: cfg.remark?.trim() || "",
  };
}

const DEFAULT_ENV_TAG = "dev";

export function buildCloudConnection(
  form: CloudFormData,
  existing?: Connection,
  tags: string[] = [],
): Connection {
  const regions = normalizeCloudRegions(form.regions);
  const pluginId = form.pluginId.trim() || PLUGIN_ID_ALIYUN;
  const config: CloudConfigJson = {
    pluginId,
    provider: isTencentCloud(pluginId) ? "tencent" : pluginId === PLUGIN_ID_ALIYUN ? "aliyun" : pluginId,
    regions,
    region: regions[0],
    accessKeyId: form.accessKeyId.trim(),
    remark: form.remark.trim() || undefined,
  };
  if (form.accessKeySecret.trim()) {
    config.accessKeySecret = form.accessKeySecret.trim();
  }
  const now = Date.now();
  return {
    id: existing?.id ?? "",
    kind: "cloud",
    name: form.name.trim(),
    group: existing?.group ?? "",
    envTag: existing?.envTag?.trim() || DEFAULT_ENV_TAG,
    tags,
    config: JSON.stringify(config),
    credentialRef: existing?.credentialRef ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

export type CloudAccount = {
  id: string;
  name: string;
  pluginId: string;
  /** 展示用，旧账户可能是 aliyun */
  provider: string;
  regions: string[];
  accessKeyId: string;
  remark: string;
  envTag: string;
};

export function connectionToCloudAccount(connection: Connection): CloudAccount | null {
  if (connection.kind !== "cloud") return null;
  const cfg = parseCloudConfig(connection);
  const regions = normalizeCloudRegions(cfg.regions, cfg.region);
  const pluginId = resolveCloudPluginId(cfg);
  return {
    id: connection.id,
    name: connection.name,
    pluginId,
    provider: cfg.provider?.trim() || pluginId,
    regions,
    accessKeyId: cfg.accessKeyId?.trim() || "",
    remark: cfg.remark?.trim() || "",
    envTag: connection.envTag?.trim() || "dev",
  };
}

export function capabilityI18nKey(capabilityId: string): string {
  const camel = capabilityId.replace(/\.([a-zA-Z])/g, (_, letter: string) => letter.toUpperCase());
  return `cloud.capability.${camel}`;
}

export function formatCloudFieldValue(t: (key: string) => string, key: string, value: string): string {
  if (!value) return value;
  if (key === "chargeType") {
    const mapped = t(`cloud.chargeType.${value}`);
    if (mapped && mapped !== `cloud.chargeType.${value}`) return mapped;
  }
  if (key === "category") {
    const mapped = t(`cloud.diskCategory.${value}`);
    if (mapped && mapped !== `cloud.diskCategory.${value}`) return mapped;
  }
  if (key === "type") {
    const diskType = t(`cloud.diskType.${value}`);
    if (diskType && diskType !== `cloud.diskType.${value}`) return diskType;
    const snapType = t(`cloud.snapshotType.${value}`);
    if (snapType && snapType !== `cloud.snapshotType.${value}`) return snapType;
  }
  if (key === "status" || key === "domainStatus") {
    const statusKey = `cloud.instanceStatus.${value}`;
    const statusMapped = t(statusKey);
    if (statusMapped && statusMapped !== statusKey) return statusMapped;
    const domainKey = `cloud.domainStatus.${value}`;
    const domainMapped = t(domainKey);
    if (domainMapped && domainMapped !== domainKey) return domainMapped;
  }
  return value;
}

export function parseCloudDateMs(raw: string | undefined): number | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (/^\d{10,13}$/.test(value)) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return n < 1e12 ? n * 1000 : n;
  }
  const iso = Date.parse(value);
  if (Number.isFinite(iso)) return iso;
  const compact = Date.parse(value.replace(" ", "T"));
  return Number.isFinite(compact) ? compact : null;
}
