import SparkMD5 from "spark-md5";

/** 1Panel API 认证前缀，见 https://1panel.cn/docs/v2/dev_manual/api_manual/ */
export const ONEPANEL_TOKEN_PREFIX = "1panel";

export interface OnePanelEndpoint {
  /** `scheme://host[:port]`，不含安全入口路径。 */
  baseUrl: string;
  /** 安全入口段（无 leading `/`）。 */
  entrance: string;
}

function normalizeEntranceSegment(raw: string): string {
  return raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function stripAccidentalApiSuffix(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed.endsWith("/api/v2")) return trimmed.slice(0, -"/api/v2".length).replace(/\/+$/, "");
  if (trimmed.endsWith("/api/v1")) return trimmed.slice(0, -"/api/v1".length).replace(/\/+$/, "");
  return trimmed;
}

/** 从面板地址解析 API origin 与安全入口（API 走 `/api/v2` + `EntranceCode` 头）。 */
export function resolveOnePanelEndpoint(host: string, entrance?: string): OnePanelEndpoint {
  let normalized = host.trim();
  if (!normalized) {
    return { baseUrl: "", entrance: "" };
  }
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `http://${normalized}`;
  }
  try {
    const u = new URL(normalized);
    const origin = `${u.protocol}//${u.host}`;
    let ent = normalizeEntranceSegment(entrance ?? "");
    const path = stripAccidentalApiSuffix(u.pathname);
    if (path && path !== "/") {
      const segment = normalizeEntranceSegment(path.split("/").filter(Boolean)[0] ?? "");
      if (segment) ent = segment;
    }
    return { baseUrl: origin, entrance: ent };
  } catch {
    return { baseUrl: normalized.replace(/\/+$/, ""), entrance: normalizeEntranceSegment(entrance ?? "") };
  }
}

/**
 * 生成 1Panel-Token：`md5('1panel' + API-Key + UnixTimestamp)`（小写 hex）。
 */
export function buildOnePanelToken(apiKey: string, timestampSec: number): string {
  return SparkMD5.hash(`${ONEPANEL_TOKEN_PREFIX}${apiKey}${timestampSec}`);
}

/** 构建请求所需的认证 Header（含可选 `EntranceCode`）。 */
export function buildOnePanelAuthHeaders(
  apiKey: string,
  timestampSec = Math.floor(Date.now() / 1000),
  entrance = "",
): Record<string, string> {
  const headers: Record<string, string> = {
    "1Panel-Token": buildOnePanelToken(apiKey, timestampSec),
    "1Panel-Timestamp": String(timestampSec),
  };
  const ent = normalizeEntranceSegment(entrance);
  if (ent) {
    headers.EntranceCode = btoa(ent);
  }
  return headers;
}

/** 规范化 1Panel API 根地址（仅 origin，不含 `/api/v2` 与安全入口路径）。 */
export function normalizeOnePanelBaseUrl(host: string, entrance?: string): string {
  return resolveOnePanelEndpoint(host, entrance).baseUrl;
}

/** 浏览器打开面板用的完整 URL（origin + 安全入口路径）。 */
export function onePanelBrowserUrl(host: string, entrance?: string): string {
  const endpoint = resolveOnePanelEndpoint(host, entrance);
  if (!endpoint.baseUrl) return "";
  if (!endpoint.entrance) return endpoint.baseUrl;
  return `${endpoint.baseUrl}/${endpoint.entrance}`;
}
