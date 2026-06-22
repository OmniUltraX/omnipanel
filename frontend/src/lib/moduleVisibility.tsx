import { createContext, useContext, type ReactNode } from "react";

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
  return (
    <ModuleVisibilityContext.Provider value={{ active, suspended: isSuspended }}>
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
