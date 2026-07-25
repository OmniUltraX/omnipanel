import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./isTauriRuntime";

/** SplashScreen 首帧后：露出固定小尺寸启动窗 */
export function showSplashWindow(): void {
  if (!isTauriRuntime()) return;
  void invoke("main_window_show_splash").catch((e) => {
    console.warn("[boot] show splash 失败", e);
  });
}

/** 启动完成 / 登录：放大到正式主窗尺寸 */
export function expandMainWindow(): void {
  if (!isTauriRuntime()) return;
  void invoke("main_window_reveal").catch((e) => {
    console.warn("[boot] expand 失败", e);
  });
}

/** @deprecated 使用 expandMainWindow */
export function revealMainWindow(): void {
  expandMainWindow();
}
