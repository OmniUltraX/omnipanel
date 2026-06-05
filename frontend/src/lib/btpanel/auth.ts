import SparkMD5 from "spark-md5";

/**
 * 生成宝塔 API 签名 token：`md5(string(request_time) + md5(api_sk))`（小写 hex）。
 * 见 https://www.bt.cn/data/api-doc.pdf
 */
export function buildBtRequestToken(apiSk: string, requestTimeSec: number): string {
  const apiKeyMd5 = SparkMD5.hash(apiSk);
  return SparkMD5.hash(`${requestTimeSec}${apiKeyMd5}`);
}

/** 构建带签名的表单字段（request_time / request_token）。 */
export function buildBtAuthFields(
  apiSk: string,
  requestTimeSec = Math.floor(Date.now() / 1000),
): Record<string, string> {
  return {
    request_time: String(requestTimeSec),
    request_token: buildBtRequestToken(apiSk, requestTimeSec),
  };
}

/** 规范化面板地址为 origin（无尾部斜杠）。未带协议时默认 http。 */
export function normalizeBtPanelBaseUrl(host: string): string {
  let normalized = host.trim().replace(/\/+$/, "");
  if (!normalized) {
    throw new Error("宝塔面板地址不能为空");
  }
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `http://${normalized}`;
  }
  return normalized;
}
