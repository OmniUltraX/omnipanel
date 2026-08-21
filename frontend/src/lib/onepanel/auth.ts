import SparkMD5 from "spark-md5";

/** 1Panel API 认证前缀，见 https://1panel.cn/docs/v2/dev_manual/api_manual/ */
export const ONEPANEL_TOKEN_PREFIX = "1panel";

/**
 * 生成 1Panel-Token：`md5('1panel' + API-Key + UnixTimestamp)`（小写 hex）。
 */
export function buildOnePanelToken(apiKey: string, timestampSec: number): string {
  return SparkMD5.hash(`${ONEPANEL_TOKEN_PREFIX}${apiKey}${timestampSec}`);
}

/** 构建请求所需的认证 Header。 */
export function buildOnePanelAuthHeaders(
  apiKey: string,
  timestampSec = Math.floor(Date.now() / 1000),
): Record<string, string> {
  return {
    "1Panel-Token": buildOnePanelToken(apiKey, timestampSec),
    "1Panel-Timestamp": String(timestampSec),
  };
}

/** 规范化面板地址为 origin（scheme://host:port，无安全入口路径）。未带协议时默认 http。 */
export function normalizeOnePanelBaseUrl(host: string): string {
  let normalized = host.trim();
  if (!normalized) {
    throw new Error("1Panel 地址不能为空");
  }
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `http://${normalized}`;
  }
  try {
    const u = new URL(normalized);
    return `${u.protocol}//${u.host}`;
  } catch {
    return normalized.replace(/\/+$/, "");
  }
}
