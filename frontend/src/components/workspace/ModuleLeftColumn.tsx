import type { ReactNode } from "react";
import { ModuleDockTitle } from "../dock/ModuleDockTitle";
import { useWindowDragOnMouseDown } from "../../lib/useWindowDragOnMouseDown";
import { ModuleTagHeader } from "../../modules/tags/ModuleTagHeader";

export interface ModuleLeftColumnProps {
  /** 顶栏左侧标题（模块名） */
  title?: ReactNode;
  iconRail?: ReactNode;
  /** 顶栏操作区额外按钮（如「问 AI」），排在 iconRail 之前 */
  headerActions?: ReactNode;
  sidebar?: ReactNode;
  className?: string;
  /** 启用全局标签筛选：标题旁入口 + chips */
  tagModuleKey?: string;
}

/** 左侧列：顶栏（对齐终端 session 树标题行）+ 资源侧栏 */
export function ModuleLeftColumn({
  title,
  iconRail,
  headerActions,
  sidebar,
  className,
  tagModuleKey,
}: ModuleLeftColumnProps) {
  const showHeader = Boolean(title || iconRail || headerActions || tagModuleKey);
  const onHeaderMouseDown = useWindowDragOnMouseDown();
  const hasActions = Boolean(iconRail || headerActions);

  return (
    <div className={["module-left-column", className].filter(Boolean).join(" ")}>
      {showHeader ? (
        <div
          className={[
            "module-sidebar-module-header",
            "module-left-column__header",
            "window-drag-surface",
            iconRail || tagModuleKey || headerActions ? "module-left-column__header--with-modes" : "",
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
          {hasActions ? (
            <div className="module-sidebar-module-header__actions window-drag-surface--interactive">
              {headerActions}
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
