/** 文件模块详情侧栏显隐（全局共用，不按连接分存） */
const STORAGE_KEY = "omnipanel.files.detailVisible";

export function readStoredFilesDetailVisible(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return true;
    return raw !== "0" && raw !== "false";
  } catch {
    return true;
  }
}

export function writeStoredFilesDetailVisible(visible: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, visible ? "1" : "0");
  } catch {
    // ignore
  }
}
