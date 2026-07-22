/**
 * Follow 意图统一分发注册表。
 *
 * 设计理念：Controller 不再硬编码每个模块的 store 调用，而是通过 registry
 * 分发到已注册的 handler。每个面板通过 useUiFollowConsumer hook 声明式注册
 * 自己的 follow handler，实现「面板自洽」——面板最清楚自己的资源定位 API。
 *
 * 流程：
 * 1. 面板挂载 → useUiFollowConsumer(module, handler) 注册 handler
 * 2. Controller 派发 intent → dispatchFollow(module, intent)
 * 3. 如果有 handler 响应 → 执行 handler，返回 true
 * 4. 如果无 handler（面板未挂载）→ 返回 false，由 Controller 入 pending 队列
 * 5. 面板挂载时 → useUiFollowConsumer 自动消费 pending intents
 *
 * 多 handler 策略：支持同一模块注册多个 handler（如 DatabasePanel 主 handler
 * + ResourceProfileSubWindow 辅 handler），按注册顺序调用，首个返回 true 即停止。
 */
import type { FollowModuleKey, UiFollowIntent } from "./types";

type FollowHandler = (intent: UiFollowIntent) => boolean;

const handlers = new Map<FollowModuleKey, Set<FollowHandler>>();

/**
 * 注册指定模块的 follow handler。
 * 返回 unregister 函数（组件卸载时调用）。
 */
export function registerFollowHandler(
  module: FollowModuleKey,
  handler: FollowHandler,
): () => void {
  let set = handlers.get(module);
  if (!set) {
    set = new Set();
    handlers.set(module, set);
  }
  set.add(handler);
  return () => {
    const s = handlers.get(module);
    if (s) {
      s.delete(handler);
      if (s.size === 0) handlers.delete(module);
    }
  };
}

/**
 * 向指定模块分发 follow intent。
 * @returns true 表示有 handler 处理了；false 表示无 handler（面板未挂载）
 */
export function dispatchFollow(
  module: FollowModuleKey,
  intent: UiFollowIntent,
): boolean {
  const set = handlers.get(module);
  if (!set || set.size === 0) return false;
  for (const handler of set) {
    try {
      if (handler(intent)) return true;
    } catch {
      // handler 异常不应阻断后续 handler 或整个 follow 流程
    }
  }
  return false;
}

/** 检查指定模块是否有已注册的 handler（调试用）。 */
export function hasFollowHandler(module: FollowModuleKey): boolean {
  const set = handlers.get(module);
  return !!set && set.size > 0;
}
