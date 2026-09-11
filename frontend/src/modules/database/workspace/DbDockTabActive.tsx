import { memo, type ReactNode } from "react";
import { useDbDockTabActive, useDbDockTabVisible } from "../useDbDockTabActive";

/** 把激活态从 renderDockPanel 闭包挪到按 tab 订阅，避免切 Tab 重建整个 render 回调 */
export const DbDockTabActive = memo(function DbDockTabActive({
  tabId,
  children,
}: {
  tabId: string;
  children: (active: boolean) => ReactNode;
}) {
  const active = useDbDockTabActive(tabId);
  return <>{children(active)}</>;
});

/**
 * 可见态（聚焦面板 或 分屏中某 group 的 active panel）。
 *
 * 用于「是否 display:none」这类隐藏判断：分屏后非聚焦 group 的面板仍然可见，
 * 用聚焦态（DbDockTabActive）会让另一侧整块空白。
 */
export const DbDockTabVisible = memo(function DbDockTabVisible({
  tabId,
  children,
}: {
  tabId: string;
  children: (visible: boolean) => ReactNode;
}) {
  const visible = useDbDockTabVisible(tabId);
  return <>{children(visible)}</>;
});
