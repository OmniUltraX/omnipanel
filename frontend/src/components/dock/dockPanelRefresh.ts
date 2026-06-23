/** Dock panel 内容刷新 props（ModuleSegmentDock / DockableWorkspace 共用） */
export interface DockPanelRefreshProps {
  /** 递增/变更时刷新 panel 内容（renderPanel 在 dockview 内不会随父 state 自动重绘） */
  panelContentKey?: string;
  /** 软刷新 key：变更时触发 panel re-render 而非 remount（保持嵌套 dock 状态） */
  softRefreshKey?: string;
}
