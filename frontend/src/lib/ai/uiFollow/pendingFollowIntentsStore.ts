/**
 * 统一的未挂载面板 Follow 意图队列。
 *
 * 核心问题：Follow intent 派发时目标面板可能尚未挂载（路由未切过去）。
 * 旧方案中只有 KnowledgePanel 用 localStorage 兜底，其他模块事件丢失。
 *
 * 统一方案：
 * 1. Controller 派发 intent 时先尝试 dispatch 到已注册的 handler
 * 2. 如果没有 handler 响应（面板未挂载），enqueue 到此 store
 * 3. 面板挂载时通过 useUiFollowConsumer 自动消费 pending intents
 *
 * 设计要点：
 * - 用 zustand + persist（localStorage），跨路由切换不丢失
 * - 按模块路由 key 分桶，避免消费时遍历全部
 * - 每个 intent 带 ts，消费时可选择性过滤过期项（默认无 TTL）
 * - 消费是原子操作：取出即清空对应桶
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { FollowModuleKey, UiFollowIntent } from "./types";

interface PendingEntry {
  intent: UiFollowIntent;
  ts: number;
}

interface PendingFollowIntentsState {
  /** 按模块 key 分桶的待处理意图 */
  buckets: Partial<Record<FollowModuleKey, PendingEntry[]>>;
  /** 入队 */
  enqueue: (module: FollowModuleKey, intent: UiFollowIntent) => void;
  /** 取出并清空指定模块的全部 pending（原子消费） */
  consumeByModule: (module: FollowModuleKey) => UiFollowIntent[];
  /** 查看指定模块是否有 pending（不消费） */
  hasPending: (module: FollowModuleKey) => boolean;
  /** 清空指定模块 */
  clearByModule: (module: FollowModuleKey) => void;
  /** 清空所有（调试/重置用） */
  clearAll: () => void;
}

const MAX_BUCKET_SIZE = 20;

export const usePendingFollowIntentsStore = create<PendingFollowIntentsState>()(
  persist(
    (set, get) => ({
      buckets: {},
      enqueue: (module, intent) =>
        set((s) => {
          const existing = s.buckets[module] ?? [];
          const next = [...existing, { intent, ts: Date.now() }];
          // 防止无上限增长：保留最后 MAX_BUCKET_SIZE 条
          if (next.length > MAX_BUCKET_SIZE) {
            next.splice(0, next.length - MAX_BUCKET_SIZE);
          }
          return { buckets: { ...s.buckets, [module]: next } };
        }),
      consumeByModule: (module) => {
        const bucket = get().buckets[module];
        if (!bucket || bucket.length === 0) return [];
        // 原子消费：先清空再返回
        set((s) => {
          const next = { ...s.buckets };
          delete next[module];
          return { buckets: next };
        });
        return bucket.map((e) => e.intent);
      },
      hasPending: (module) => {
        const bucket = get().buckets[module];
        return !!bucket && bucket.length > 0;
      },
      clearByModule: (module) =>
        set((s) => {
          const next = { ...s.buckets };
          delete next[module];
          return { buckets: next };
        }),
      clearAll: () => set({ buckets: {} }),
    }),
    {
      name: "omnipanel-pending-follow-intents.v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ buckets: s.buckets }),
    },
  ),
);
