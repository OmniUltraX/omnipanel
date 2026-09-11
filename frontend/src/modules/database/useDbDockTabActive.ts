import {
  useIsDbWorkspaceTabActive,
  useIsDbWorkspaceTabVisible,
} from "../../stores/dbWorkspaceActiveTabStore";

/**
 * Dock 面板**聚焦**激活态：按 tab 布尔订阅，切 Tab 时只有新旧两个面板 re-render。
 *
 * 语义是「当前聚焦的面板」（单值）：快捷键、内联编辑器、侧栏联动等用它。
 * 分屏时非聚焦 group 的面板也应正常显示，那类可见性判断请用 `useDbDockTabVisible`。
 *
 * 主 DatabasePanel 通过 syncActiveTabStore 写入 store。
 * 镜像窗请用 `active` prop 覆盖（见 DbTablePreviewSurface / DbPanelSurface），勿依赖本 hook。
 */
export function useDbDockTabActive(tabId: string): boolean {
  return useIsDbWorkspaceTabActive(tabId);
}

/**
 * Dock 面板**可见**态：聚焦面板，或分屏时任一 group 的 active panel。
 *
 * 用于 display:none / canvas 位图清理等「是否被隐藏」判断——
 * 分屏后非聚焦 group 的面板同样是可见的，若按聚焦态隐藏会出现整块空白。
 */
export function useDbDockTabVisible(tabId: string): boolean {
  return useIsDbWorkspaceTabVisible(tabId);
}
