/** 按「自动添加 /v1」解析实际 API 根路径（…/chat/completions、…/models 的前缀）。 */
export function resolveApiBaseUrl(baseUrl: string, appendV1 = true): string {
  const root = baseUrl.trim().replace(/\/+$/, "");
  if (!root || !appendV1) return root;
  if (/(?:^|\/)v\d+$/i.test(root)) return root;
  return `${root}/v1`;
}
