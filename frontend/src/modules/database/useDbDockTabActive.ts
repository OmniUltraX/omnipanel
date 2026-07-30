import { useIsDbWorkspaceTabActive } from "../../stores/dbWorkspaceActiveTabStore";

/**
 * Dock 面板激活态：按 tab 布尔订阅，切 Tab 时只有新旧两个面板 re-render。
 *
 * 主 DatabasePanel 通过 syncActiveTabStore 写入 store。
 * 镜像窗请用 `active` prop 覆盖（见 DbTablePreviewSurface / DbPanelSurface），勿依赖本 hook。
 */
export function useDbDockTabActive(tabId: string): boolean {
  return useIsDbWorkspaceTabActive(tabId);
}
