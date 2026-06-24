import { MODULE_PATHS, type ModuleKey } from "./paths";
import {
  useStatusBarLogStore,
  type StatusBarLogLevel,
} from "../stores/statusBarLogStore";

/** 路由 pathname → 模块 key；非模块页返回 null */
export function pathnameToModuleKey(pathname: string): ModuleKey | null {
  for (const key of Object.keys(MODULE_PATHS) as ModuleKey[]) {
    const base = MODULE_PATHS[key];
    if (pathname === base || pathname.startsWith(`${base}/`)) {
      return key;
    }
  }
  return null;
}

/** 仅当 module 为当前激活模块时写入状态栏日志 */
export function publishModuleStatusLog(
  module: ModuleKey,
  message: string,
  level: StatusBarLogLevel = "info",
): void {
  const { activePublisher, publish } = useStatusBarLogStore.getState();
  if (activePublisher !== module) {
    return;
  }
  publish(module, message, level);
}

export function clearModuleStatusLog(module: ModuleKey): void {
  useStatusBarLogStore.getState().clear(module);
}
