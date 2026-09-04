import type { ModuleSessionService, SessionHandle, ViewSink } from "./types";

export type TabSessionEvent =
  | { type: "bound" }
  | { type: "unbound" };

export interface TabSessionServiceOptions {
  listIds: () => string[];
  /** 真正结束会话 / 关 Tab；无后端资源时可只关 dock Tab */
  disposeId: (id: string) => void | Promise<void>;
}

/**
 * 连接/Tab 型模块的通用 SessionService：
 * - 关模块 / LRU 踢出默认保留 Tab 状态（onModuleEvicted no-op）
 * - bindView 可缓冲少量事件，供 View 再挂载时回放
 */
export function createTabSessionService(
  options: TabSessionServiceOptions,
): ModuleSessionService {
  const sinks = new Map<string, Set<ViewSink>>();
  const rings = new Map<string, TabSessionEvent[]>();

  return {
    list(): SessionHandle[] {
      return options.listIds().map((id) => ({ id }));
    },

    get(id: string): SessionHandle | null {
      return options.listIds().includes(id) ? { id } : null;
    },

    bindView(id: string, sink: ViewSink): () => void {
      if (!this.get(id)) {
        return () => undefined;
      }
      let set = sinks.get(id);
      if (!set) {
        set = new Set();
        sinks.set(id, set);
      }
      set.add(sink);
      const pending = rings.get(id) ?? [];
      rings.set(id, []);
      for (const event of pending) sink.push(event);
      sink.push({ type: "bound" } satisfies TabSessionEvent);

      return () => {
        const current = sinks.get(id);
        if (!current) return;
        current.delete(sink);
        if (current.size === 0) sinks.delete(id);
        sink.push({ type: "unbound" } satisfies TabSessionEvent);
      };
    },

    async dispose(id: string): Promise<void> {
      sinks.delete(id);
      rings.delete(id);
      await options.disposeId(id);
    },

    onModuleEvicted(): void {
      // Tab / 连接状态留在各模块 store；View 可再 bind
    },
  };
}
