import { create } from "zustand";

/**
 * @deprecated ContextBar 单选已移除；moduleFilter 一律跟焦点 dock。
 * 保留 store 以免外部引用断裂，默认保持 `""`。
 */
interface AiContextScopeState {
  scope: string;
  setScope: (scope: string) => void;
}

export const useAiContextScopeStore = create<AiContextScopeState>((set) => ({
  scope: "",
  setScope: (scope) => set({ scope }),
}));

/** @deprecated 请使用 resolveFocusModuleKey / 焦点 dock 推断。 */
export function getAiContextScope(): string {
  return useAiContextScopeStore.getState().scope;
}
