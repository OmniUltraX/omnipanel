/**
 * 顶栏「+」新建菜单的打开请求总线。
 * Dock / Topbar 中的 TopbarTabAddButton 挂载时订阅；快捷键优先打开菜单，无人接管时回退直建。
 */

type OpenListener = () => boolean;

const listeners = new Set<OpenListener>();

/** 注册打开回调；返回 true 表示已接管（打开了菜单）。 */
export function subscribeTopbarAddMenuOpen(listener: OpenListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 请求打开当前可见的顶栏新建菜单；有订阅者成功打开时返回 true。 */
export function requestOpenTopbarAddMenu(): boolean {
  for (const listener of listeners) {
    if (listener()) return true;
  }
  return false;
}
