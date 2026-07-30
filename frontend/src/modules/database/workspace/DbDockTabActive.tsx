import { memo, type ReactNode } from "react";
import { useDbDockTabActive } from "../useDbDockTabActive";

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
