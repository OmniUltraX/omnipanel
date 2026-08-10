export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Web 构建（`OMNIPANEL_WEB=1`）是否通过 Vite define 注入。 */
export function isOmnipanelWebBuild(): boolean {
  return typeof __OMNIPANEL_WEB__ !== "undefined" && __OMNIPANEL_WEB__ === true;
}

/**
 * 是否可走 omnipanel IPC 后端（桌面 Tauri 或 Web → omnipanel-server）。
 * 凡业务读写走 `commands.*` / Channel 的能力，应优先用本判断，而不是裸 `isTauriRuntime()`。
 * 多窗口 / 托盘 / 系统字体枚举等纯桌面壳能力仍用 `isTauriRuntime()`。
 */
export function canUseIpcBackend(): boolean {
  return isTauriRuntime() || isOmnipanelWebBuild();
}

/** @deprecated 使用 {@link canUseIpcBackend} */
export function canUseTerminalBackend(): boolean {
  return canUseIpcBackend();
}

/** @deprecated 使用 {@link canUseIpcBackend} */
export function canUseAiBackend(): boolean {
  return canUseIpcBackend();
}
