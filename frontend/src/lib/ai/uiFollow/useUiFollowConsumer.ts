/**
 * 面板声明式注册 Follow 消费者。
 *
 * 用法（在模块面板组件中）：
 * ```tsx
 * useUiFollowConsumer("database", useCallback((intent) => {
 *   switch (intent.type) {
 *     case "openSqlDraft":
 *       handleOpenSqlDraft(intent.connectionId, intent.database, intent.sql);
 *       return true;
 *     case "selectTable":
 *       handleSelectTable(intent.connectionId, intent.database, intent.table);
 *       return true;
 *     default:
 *       return false;
 *   }
 * }, [/* deps *\/]));
 * ```
 *
 * 自动处理：
 * 1. 注册 handler 到 followRegistry
 * 2. 面板挂载时自动消费 pendingFollowIntentsStore 中属于自己的 pending intents
 * 3. 面板卸载时自动注销 handler
 *
 * handler 返回值语义：
 * - true：已处理此 intent
 * - false：不认识此 intent，让其他 handler 或 pending 队列处理
 */
import { useEffect, useRef } from "react";
import type { FollowModuleKey, UiFollowIntent } from "./types";
import { registerFollowHandler } from "./followRegistry";
import { usePendingFollowIntentsStore } from "./pendingFollowIntentsStore";

export function useUiFollowConsumer(
  module: FollowModuleKey,
  handler: (intent: UiFollowIntent) => boolean,
): void {
  // 用 ref 持有最新 handler，避免每次 render 重新注册
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    // 1. 注册 handler
    const unregister = registerFollowHandler(module, (intent) =>
      handlerRef.current(intent),
    );

    // 2. 消费挂载前累积的 pending intents
    //    用微任务延迟，确保面板的内部 store 已初始化（如 DatabasePanel 的 tabs state）
    const pending = usePendingFollowIntentsStore.getState().consumeByModule(module);
    if (pending.length > 0) {
      queueMicrotask(() => {
        for (const intent of pending) {
          try {
            handlerRef.current(intent);
          } catch {
            // 消费 pending 时 handler 异常不应阻断后续
          }
        }
      });
    }

    return unregister;
  }, [module]);
}
