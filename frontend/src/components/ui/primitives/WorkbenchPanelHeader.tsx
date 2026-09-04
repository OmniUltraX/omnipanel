import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type WorkbenchHeaderTag = {
  text: string;
  title?: string;
  emphasis?: boolean;
};

export type WorkbenchPanelHeaderProps = {
  label?: ReactNode;
  tags?: WorkbenchHeaderTag[];
  extra?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

/** 工作台页头：10px 标签 + 元信息芯片 + 右侧幽灵操作。 */
export function WorkbenchPanelHeader({
  label,
  tags,
  extra,
  actions,
  className,
}: WorkbenchPanelHeaderProps) {
  return (
    <header className={cn("workbench-panel-header", className)}>
      {label != null && label !== "" ? (
        <span className="workbench-panel-header-label">{label}</span>
      ) : null}
      {tags && tags.length > 0 ? (
        <div className="workbench-panel-header-tags">
          {tags.map((tag, index) => (
            <span
              key={`${tag.text}:${index}`}
              className={cn(
                "workbench-panel-header-tag",
                tag.emphasis && "workbench-panel-header-tag--name",
              )}
              title={tag.title ?? tag.text}
            >
              {tag.text}
            </span>
          ))}
        </div>
      ) : extra ? (
        <div className="workbench-panel-header-tags">{extra}</div>
      ) : null}
      {actions ? <div className="workbench-panel-header-actions">{actions}</div> : null}
    </header>
  );
}
