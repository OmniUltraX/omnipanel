/**
 * 判断资源保存是否只改了名称（或备注）字段。
 *
 * 名称/备注为设备本地字段，不参与云端同步：纯改名不触发模块快照推送。
 * 除名称字段与 `updatedAt` 外其余字段完全一致时视为纯改名。
 */
export function isNameOnlyChange<T extends object>(
  next: T,
  prev: T | undefined,
  nameField: keyof T,
): boolean {
  if (!prev) return false;
  if (next[nameField] === prev[nameField]) return false;
  const nextRecord = next as Record<string, unknown>;
  const prevRecord = prev as Record<string, unknown>;
  const keys = new Set([...Object.keys(nextRecord), ...Object.keys(prevRecord)]);
  for (const key of keys) {
    if (key === (nameField as string) || key === "updatedAt") continue;
    if (JSON.stringify(nextRecord[key]) !== JSON.stringify(prevRecord[key])) return false;
  }
  return true;
}
