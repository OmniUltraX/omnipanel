import type { ReactNode } from "react";
import { ModuleDockTitle } from "../dock/ModuleDockTitle";
import { useWindowDragOnMouseDown } from "../../lib/useWindowDragOnMouseDown";
import { ModuleTagHeader } from "../../modules/tags/ModuleTagHeader";

export interface ModuleLeftColumnProps {
  /** 顶栏左侧标题（模块名） */
  title?: ReactNode;
  iconRail?: ReactNode;
  sidebar?: ReactNode;
  className?: string;
  /** 启用全局标签筛选：标题旁入口 + chips */
  tagModuleKey?: string;
}

/** 左侧列：顶栏（对齐终端 session 树标题行）+ 资源侧栏 */
export function ModuleLeftColumn({
  title,
  iconRail,
  sidebar,
  className,
  tagModuleKey,
}: ModuleLeftColumnProps) {
  const showHeader = Boolean(title || iconRail || tagModuleKey);
  const onHeaderMouseDown = useWindowDragOnMouseDown();

  return (
    <div className={["module-left-column", className].filter(Boolean).join(" ")}>
      {showHeader ? (
        <div
          className={[
            "module-sidebar-module-header",
            "module-left-column__header",
            "window-drag-surface",
            iconRail || tagModuleKey ? "module-left-column__header--with-modes" : "",
            tagModuleKey ? "module-left-column__header--with-tags" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          data-tauri-drag-region
          onMouseDown={onHeaderMouseDown}
        >
          {title ? <ModuleDockTitle>{title}</ModuleDockTitle> : null}
          {tagModuleKey ? (
            <div className="module-sidebar-module-header__tags">
              <ModuleTagHeader moduleKey={tagModuleKey} />
            </div>
          ) : (
            <div className="module-sidebar-module-header__spacer" aria-hidden data-tauri-drag-region />
          )}
          {iconRail ? (
            <div className="module-sidebar-module-header__actions window-drag-surface--interactive">
              {iconRail}
            </div>
          ) : tagModuleKey ? (
            <div className="module-sidebar-module-header__actions-spacer" aria-hidden />
          ) : null}
        </div>
      ) : null}
      {sidebar ? <div className="module-left-column__sidebar">{sidebar}</div> : null}
    </div>
  );
}
