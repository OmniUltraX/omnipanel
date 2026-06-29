/** 常用 HTTP 请求头键名 */
export const HTTP_HEADER_KEYS = [
  "Accept",
  "Accept-Encoding",
  "Accept-Language",
  "Authorization",
  "Cache-Control",
  "Connection",
  "Content-Type",
  "Cookie",
  "Host",
  "Origin",
  "Referer",
  "User-Agent",
  "X-API-Key",
  "X-Requested-With",
] as const;

/** 按请求头键名预定义的常用值 */
export const HTTP_HEADER_VALUE_PRESETS: Record<string, readonly string[]> = {
  Accept: ["application/json", "application/xml", "text/html", "text/plain", "*/*"],
  "Accept-Encoding": ["gzip, deflate, br"],
  "Accept-Language": ["zh-CN,zh;q=0.9", "en-US,en;q=0.9"],
  Authorization: ["Bearer ", "Basic "],
  "Cache-Control": ["no-cache", "no-store", "max-age=0"],
  Connection: ["keep-alive", "close"],
  "Content-Type": [
    "application/json",
    "application/x-www-form-urlencoded",
    "multipart/form-data",
    "text/plain",
    "application/xml",
  ],
  "User-Agent": ["Mozilla/5.0"],
  "X-Requested-With": ["XMLHttpRequest"],
};

export function headerKeyOptions(currentKey: string): string[] {
  const keys = new Set<string>(HTTP_HEADER_KEYS);
  const trimmed = currentKey.trim();
  if (trimmed) keys.add(trimmed);
  return [...keys];
}

export function headerValueOptions(headerKey: string, currentValue: string): string[] {
  const presets = HTTP_HEADER_VALUE_PRESETS[headerKey] ?? [];
  const values = new Set<string>(presets);
  const trimmed = currentValue.trim();
  if (trimmed) values.add(trimmed);
  if (values.size === 0) return [""];
  return [...values];
}
