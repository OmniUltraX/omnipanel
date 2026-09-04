import { createContext, useContext, useMemo, type ReactNode } from "react";

export interface ModuleVisibilityState {
  /** 当前路由是否为该模块的 active 路由 */
  active: boolean;
  /** 模块应暂停 IPC / 重渲染（路由隐藏或显式 suspend） */
  suspended: boolean;
}

const ModuleVisibilityContext = createContext<ModuleVisibilityState>({
  active: true,
  suspended: false,
});

export function ModuleVisibilityProvider({
  active,
  suspended,
  children,
}: {
  active: boolean;
  suspended?: boolean;
  children: ReactNode;
}) {
  const isSuspended = suspended ?? !active;
  // 稳定引用：active/suspended 未变时不触发下游 useModuleVisibility 消费者重渲
  const value = useMemo(
    () => ({ active, suspended: isSuspended }),
    [active, isSuspended],
  );
  return (
    <ModuleVisibilityContext.Provider value={value}>
      {children}
    </ModuleVisibilityContext.Provider>
  );
}

export function useModuleVisibility() {
  return useContext(ModuleVisibilityContext);
}

export function useModuleSuspended() {
  return useContext(ModuleVisibilityContext).suspended;
}
