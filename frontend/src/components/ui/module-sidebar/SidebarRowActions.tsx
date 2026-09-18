import type { MouseEvent, ReactNode } from "react";

/**
 * 树行 hover 操作容器：复用 `tree-node-actions` 的显隐语义（悬停/聚焦才显），
 * 点击默认阻止冒泡，避免误触行选中。替代各模块裸 `+` / `×` 文本按钮。
 */
export function SidebarRowActions({ children }: { children: ReactNode }) {
  const stop = (event: MouseEvent) => event.stopPropagation();
  return (
    <div
      className="tree-node-actions sidebar-row-actions"
      onClick={stop}
      onDoubleClick={stop}
    >
      {children}
    </div>
  );
}
