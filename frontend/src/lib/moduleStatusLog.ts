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

/**
 * 写入该模块自己的状态栏日志。
 * 不因当前是否激活而丢弃结束态，避免后台完成的刷新留下「正在刷新…」。
 * 展示仍由 StatusBar 按 activePublisher 选取。
 */
export function publishModuleStatusLog(
  module: ModuleKey,
  message: string,
  level: StatusBarLogLevel = "info",
): void {
  useStatusBarLogStore.getState().publish(module, message, level);
}

export function clearModuleStatusLog(module: ModuleKey): void {
  useStatusBarLogStore.getState().clear(module);
}
