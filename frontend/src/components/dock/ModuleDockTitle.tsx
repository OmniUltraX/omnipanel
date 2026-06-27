import type { ReactNode } from "react";

interface ModuleDockTitleProps {
  children: ReactNode;
}

/** 模块 dock tab 栏左侧标题，样式对齐设计稿 .topbar-title */
export function ModuleDockTitle({ children }: ModuleDockTitleProps) {
  return (
    <span className="topbar-title module-dock-title" data-tauri-drag-region>
      {children}
    </span>
  );
}
