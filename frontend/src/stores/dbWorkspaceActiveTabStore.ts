import { create } from "zustand";

/**
 * 数据库工作区当前激活 Tab（按 tab 布尔订阅）。
 *
 * 勿直接用 ActiveTab Context 的 activeTabId：Context 一变，所有订阅组件全量 re-render。
 * 用 `useIsDbWorkspaceTabActive(tabId)` 只在「我是否激活」翻转时更新。
 *
 * **activeTabId 是「聚焦」单值**（侧栏联动、快捷键、内联编辑器都只属于聚焦面板）；
 * 分屏后 dockview 每个 group 各有一个 active panel，这些面板都是**可见**的，
 * 用 `groupActiveTabIds` 记录，供 `useIsDbWorkspaceTabVisible` 判断是否 display:none。
 */
interface DbWorkspaceActiveTabState {
  activeTabId: string;
  /** 所有 group 的 active panel（分屏时可能多个）；非聚焦 group 的面板也在此集合内 */
  groupActiveTabIds: ReadonlySet<string>;
  setActiveTabId: (id: string) => void;
  /** 由 DockableWorkspace 上报，分屏/切换 group 时更新 */
  setGroupActiveTabIds: (ids: string[]) => void;
}

export const useDbWorkspaceActiveTabStore = create<DbWorkspaceActiveTabState>((set) => ({
  activeTabId: "",
  groupActiveTabIds: new Set<string>(),
  setActiveTabId: (activeTabId) =>
    set((state) => (state.activeTabId === activeTabId ? state : { activeTabId })),
  setGroupActiveTabIds: (ids) =>
    set((state) => {
      const prev = state.groupActiveTabIds;
      // 布局变化高频触发（拖拽 resize 每帧），集合相同则不产生新 state
      if (prev.size === ids.length && ids.every((id) => prev.has(id))) return state;
      return { groupActiveTabIds: new Set(ids) };
    }),
}));

/** 仅当该 tab 的激活态翻转时触发重渲染 */
export function useIsDbWorkspaceTabActive(tabId: string): boolean {
  return useDbWorkspaceActiveTabStore((s) => s.activeTabId === tabId);
}

/**
 * 该 tab 是否「可见」：聚焦面板本身，或分屏中任一 group 的 active panel。
 * 用于 display:none / canvas 位图清理等可见性判断，勿用于快捷键、编辑器等聚焦语义。
 */
export function useIsDbWorkspaceTabVisible(tabId: string): boolean {
  return useDbWorkspaceActiveTabStore(
    (s) => s.activeTabId === tabId || s.groupActiveTabIds.has(tabId),
  );
}
