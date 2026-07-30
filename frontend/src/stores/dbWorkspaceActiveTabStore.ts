import { create } from "zustand";

/**
 * 数据库工作区当前激活 Tab（按 tab 布尔订阅）。
 *
 * 勿直接用 ActiveTab Context 的 activeTabId：Context 一变，所有订阅组件全量 re-render。
 * 用 `useIsDbWorkspaceTabActive(tabId)` 只在「我是否激活」翻转时更新。
 */
interface DbWorkspaceActiveTabState {
  activeTabId: string;
  setActiveTabId: (id: string) => void;
}

export const useDbWorkspaceActiveTabStore = create<DbWorkspaceActiveTabState>((set) => ({
  activeTabId: "",
  setActiveTabId: (activeTabId) =>
    set((state) => (state.activeTabId === activeTabId ? state : { activeTabId })),
}));

/** 仅当该 tab 的激活态翻转时触发重渲染 */
export function useIsDbWorkspaceTabActive(tabId: string): boolean {
  return useDbWorkspaceActiveTabStore((s) => s.activeTabId === tabId);
}
