import type { DockHeaderIconKind } from "./DockHeaderIcon";
import type { TopbarTabDef } from "../../stores/topbarStore";

/** Dock 面板页面类型；`file` 时 Tab 显示文件已保存/未保存标记 */
export type DockTabPageType = "file";

export interface DockableTab {
  id: string;
  label: string;
  /** 面板类型：同模块面板共享类型，用于 tab group 折叠 */
  panelType: string;
  /** 页面类型（如 SQL 查询文件面板 `file`） */
  type?: DockTabPageType;
  closable?: boolean;
  /** Tab 图标（窄侧栏仅显示图标，完整标题走 tooltip） */
  icon?: DockHeaderIconKind;
  /** 悬停提示；默认使用 label */
  tooltip?: string;
  /** topbar 风格 tab：连接状态点 */
  status?: TopbarTabDef["status"];
  /** SQL 查询文件等内容尚未落盘（Tab 上显示未保存标记） */
  dirty?: boolean;
  /** 已关联查询文件且内容已落盘（Tab 上显示已保存标记） */
  saved?: boolean;
  /** Schema 预览 Tab：标题以斜体显示 */
  preview?: boolean;
  /** 为 true 时保留 panel 但不在 Tab 栏展示（避免切换时销毁面板） */
  tabBarHidden?: boolean;
}
