/** 列选择栏折叠状态持久化（所有表共用同一个值） */
const STORAGE_KEY = "omnipanel.db.colSidebarCollapsed";

export function readStoredColSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeStoredColSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    // ignore
  }
}
