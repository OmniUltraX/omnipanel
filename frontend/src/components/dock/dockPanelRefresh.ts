/** Dock panel 内容刷新 props（ModuleSegmentDock / DockableWorkspace 共用） */
export interface DockPanelRefreshProps {
  /** 递增/变更时刷新 panel 内容（renderPanel 在 dockview 内不会随父 state 自动重绘） */
  panelContentKey?: string;
  /**
   * 软刷新 key：变更时对全部 panel bump softRev（reconcile）。
   * 切 Tab 请勿把 activeTabId 绑到这里——DockableWorkspace 已对旧/新 active 做局部 soft bump。
   * 仅用于路由 live / 连接列表等真正的跨 panel 全局软刷新。
   */
  softRefreshKey?: string;
}
