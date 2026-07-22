/**
 * Schema 节点刷新调试日志。
 * 控制台过滤：`[schema-refresh]`
 * 关闭：localStorage.setItem("omnipanel:debug-schema-refresh", "0")
 */

const STORAGE_KEY = "omnipanel:debug-schema-refresh";

export function isSchemaRefreshDebugEnabled(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "0" || raw === "false") {
      return false;
    }
  } catch {
    // ignore
  }
  return true;
}

export function schemaRefreshDebug(label: string, payload?: unknown): void {
  if (!isSchemaRefreshDebugEnabled()) {
    return;
  }
  if (payload !== undefined) {
    console.info(`[schema-refresh] ${label}`, payload);
  } else {
    console.info(`[schema-refresh] ${label}`);
  }
}
