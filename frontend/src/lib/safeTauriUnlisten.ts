/** Tauri 2 的 unlisten 为 async；webview 销毁后 reject，须吞掉 Promise */
export function safeTauriUnlisten(
  unlisten: (() => void | Promise<void>) | undefined,
): void {
  if (!unlisten) return;
  try {
    void Promise.resolve(unlisten()).catch(() => {});
  } catch {
    // 同步抛错同样忽略
  }
}
