/** 保存前格式化 JSON 请求体；非法 JSON 或空内容保持原样。 */
export function formatHttpJsonBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return body;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return body;
  }
}
