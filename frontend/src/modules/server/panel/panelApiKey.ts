/** 探测到的字符串能否当作面板 API 密钥回填。 */
export function isUsablePanelApiKey(kind: string, key: string | undefined | null): boolean {
  const k = (key ?? "").trim();
  if (k.length < 8 || k.length > 128) return false;
  // 宝塔 32 位 hex 多半是 token=md5(key)，客户端会再 md5 一次
  if (kind.trim().toLowerCase() === "bt" && /^[0-9a-fA-F]{32}$/.test(k)) return false;
  return true;
}
