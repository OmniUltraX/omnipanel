import { getAllWindows } from "@tauri-apps/api/window";
import { isTauriRuntime } from "./isTauriRuntime";
import { clearWindowHiddenToTray } from "./trayHiddenWindows";
import { QUICK_LAUNCHER_LABEL } from "./quickLauncher";

/** 是否有任一业务窗口处于前台（可见且聚焦）。 */
export async function isAppInBackground(): Promise<boolean> {
  if (!isTauriRuntime()) {
    return document.visibilityState === "hidden";
  }
  try {
    const windows = await getAllWindows();
    for (const win of windows) {
      if (win.label === QUICK_LAUNCHER_LABEL) continue;
      try {
        const [visible, focused] = await Promise.all([
          win.isVisible(),
          win.isFocused(),
        ]);
        if (visible && focused) return false;
      } catch {
        // 忽略单个窗口探测失败
      }
    }
    return true;
  } catch {
    return document.visibilityState === "hidden";
  }
}

/** 显示并聚焦主窗口（通知点击后唤起）。 */
export async function focusMainWindow(): Promise<void> {
  if (!isTauriRuntime()) {
    window.focus();
    return;
  }
  try {
    const windows = await getAllWindows();
    const main =
      windows.find((w) => w.label === "main") ??
      windows.find((w) => w.label !== QUICK_LAUNCHER_LABEL) ??
      windows[0];
    if (!main) return;
    await main.show();
    await main.unminimize();
    await main.setFocus();
    clearWindowHiddenToTray(main.label);
  } catch (e) {
    console.warn("[lanShare] focusMainWindow failed", e);
  }
}
