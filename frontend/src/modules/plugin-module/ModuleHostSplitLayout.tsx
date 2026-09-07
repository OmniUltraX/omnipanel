import { Children, type ReactNode } from "react";
import { DockHandle, DockLayout, DockPanel } from "../../components/dock";

type ModuleHostSplitLayoutProps = {
  children: ReactNode;
};

/**
 * 模块能力页左右分栏：列表 / 树 + 详情，拖动中间分隔条调整宽度。
 * 仅渲染出的非空子节点参与分栏（通常恰好两栏）。
 */
export function ModuleHostSplitLayout({ children }: ModuleHostSplitLayoutProps) {
  const panes = Children.toArray(children).filter(Boolean);
  if (panes.length < 2) {
    return <>{panes}</>;
  }

  const [left, ...right] = panes;
  return (
    <DockLayout className="module-host-split__layout">
      <DockPanel
        defaultSize="30%"
        minSize="18%"
        maxSize="55%"
        className="module-host-split__pane"
      >
        {left}
      </DockPanel>
      <DockHandle />
      <DockPanel defaultSize="70%" minSize="40%" className="module-host-split__pane">
        {right.length === 1 ? right[0] : right}
      </DockPanel>
    </DockLayout>
  );
}
