/**
 * 不订阅 React Router：读取并可选清除 history.state 字段。
 * 用于模块深链（如 Docker 选中连接、SFTP），避免 useLocation 导致保活模块随路由重渲。
 */
export function peekHistoryStateRecord(): Record<string, unknown> | null {
  try {
    const state = window.history.state;
    if (!state || typeof state !== "object") return null;
    const record = state as Record<string, unknown>;
    const usr = record.usr;
    if (usr && typeof usr === "object") {
      return { ...record, ...(usr as Record<string, unknown>) };
    }
    return record;
  } catch {
    return null;
  }
}

export function peekHistoryStateField<T = unknown>(key: string): T | undefined {
  const record = peekHistoryStateRecord();
  if (!record || !(key in record)) return undefined;
  return record[key] as T;
}

export function clearHistoryState(): void {
  try {
    window.history.replaceState({}, "");
  } catch {
    /* ignore */
  }
}
