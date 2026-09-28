/** 快捷启动器 / 命令面板把本机路径交给文件模块。 */
export const FILES_PENDING_PATH_KEY = "omnipanel.files.pendingPath";
export const FILES_PENDING_PATH_EVENT = "omnipanel-files-pending-path";

export function publishFilesPendingPath(path: string): void {
  try {
    sessionStorage.setItem(FILES_PENDING_PATH_KEY, path);
  } catch {
    return;
  }
  window.dispatchEvent(new Event(FILES_PENDING_PATH_EVENT));
}

export function takeFilesPendingPath(): string | null {
  try {
    const path = sessionStorage.getItem(FILES_PENDING_PATH_KEY);
    if (!path) return null;
    sessionStorage.removeItem(FILES_PENDING_PATH_KEY);
    return path;
  } catch {
    return null;
  }
}
