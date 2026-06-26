/** Fetch 请求头值必须是 ISO-8859-1（ByteString），否则浏览器会拒绝发起请求。 */
const ISO_8859_1 = /^[\u0000-\u00FF]*$/;

/** 去除 BOM、零宽字符，并将常见全角 ASCII 转为半角（避免误粘贴）。 */
export function normalizeHeaderValue(value: string): string {
  return value
    .trim()
    .replace(/^\uFEFF/, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ");
}

export function assertIso8859HeaderValue(fieldLabel: string, value: string): string {
  const normalized = normalizeHeaderValue(value);
  if (!ISO_8859_1.test(normalized)) {
    throw new Error(
      `${fieldLabel} 含有无法写入 HTTP 请求头的字符（常见于 API Key 误粘贴中文或特殊符号）。请在 **设置 → AI 模型** 中检查并重新填写 API Key。`,
    );
  }
  return normalized;
}

export function buildBearerAuthorization(apiKey: string): string {
  const key = assertIso8859HeaderValue("API Key", apiKey);
  if (!key) {
    throw new Error("API Key 为空，请在 **设置 → AI 模型** 中配置 API Key。");
  }
  return `Bearer ${key}`;
}

export function buildApiKeyHeader(apiKey: string): string {
  const key = assertIso8859HeaderValue("API Key", apiKey);
  if (!key) {
    throw new Error("API Key 为空，请在 **设置 → AI 模型** 中配置 API Key。");
  }
  return key;
}

/** 将浏览器泛化的 Failed to fetch 转为可操作的提示。 */
export function enrichFetchNetworkError(url: string, error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }
  if (error.message === "Failed to fetch" || error.name === "TypeError") {
    return new Error(
      `无法连接模型 API（${url}）。请检查：\n1. Base URL 是否正确且服务可访问\n2. 网络/代理/VPN 是否正常\n3. 本地服务（如 Ollama）是否已启动\n4. 修改 CSP 或配置后需完全重启应用`,
    );
  }
  return error;
}

export async function fetchWithNetworkHint(
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    throw enrichFetchNetworkError(url, error);
  }
}
