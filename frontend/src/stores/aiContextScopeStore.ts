import { create } from "zustand";

/**
 * AI 助手上下文 scope 选择状态。
 *
 * 由 assistant 侧栏的 ContextBar Select 维护：
 * - `module:database` / `module:terminal` / ... 用户手动选择或路由推断的模块 scope
 * - `workspace:xxx` 工作区 scope
 * - `""` 未选择（回退到焦点 dock 推断）
 *
 * buildAiContext 读取此值决定 moduleFilter（传给后端 to_internal_tool_defs），
 * 让 ContextBar 的选择真正联动 AI 工具过滤。
 */
interface AiContextScopeState {
  scope: string;
  setScope: (scope: string) => void;
}

export const useAiContextScopeStore = create<AiContextScopeState>((set) => ({
  scope: "",
  setScope: (scope) => set({ scope }),
}));

/** 读取当前 scope（非 hook 版本，供 buildAiContext 等非组件代码调用）。 */
export function getAiContextScope(): string {
  return useAiContextScopeStore.getState().scope;
}
