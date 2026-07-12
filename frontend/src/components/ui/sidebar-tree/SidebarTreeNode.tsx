import {
  type CSSProperties,
  type DragEventHandler,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTreeClickDelay, type TreeRowMouseEvent } from "./useTreeClickDelay";
import "./sidebar-tree.css";

export type SidebarTreeNodeProps = {
  depth?: number;
  indentStep?: number;
  indentBase?: number;
  expanded: boolean;
  hasChildren: boolean;
  active?: boolean;
  muted?: boolean;
  label: ReactNode;
  icon?: ReactNode;
  /** 标签前的附加内容（如连接状态点） */
  prefix?: ReactNode;
  /** 标签后的附加内容（如 PK/FK badge） */
  afterLabel?: ReactNode;
  trailing?: ReactNode;
  className?: string;
  style?: CSSProperties;
  draggable?: boolean;
  onDragStart?: DragEventHandler<HTMLDivElement>;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDragLeave?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
  onDragEnd?: DragEventHandler<HTMLDivElement>;
  onToggle: () => void;
  onClick?: (event: TreeRowMouseEvent) => void;
  onDoubleClick?: (event: TreeRowMouseEvent) => void;
  /** 同时提供 onClick / onDoubleClick 时默认 200ms；设为 0 则不做防抖 */
  clickDelayMs?: number;
  shouldIgnoreClick?: (target: EventTarget | null) => boolean;
  onContextMenu?: (event: TreeRowMouseEvent) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /** 透传 data-* 属性 */
  dataAttrs?: Record<string, string>;
};

export function SidebarTreeNode({
  depth = 0,
  indentStep = 16,
  indentBase = 8,
  expanded,
  hasChildren,
  active = false,
  muted = false,
  label,
  icon,
  prefix,
  afterLabel,
  trailing,
  className = "",
  style,
  draggable,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onToggle,
  onClick,
  onDoubleClick,
  clickDelayMs,
  shouldIgnoreClick,
  onContextMenu,
  onPointerDown,
  dataAttrs,
}: SidebarTreeNodeProps) {
  const delay =
    clickDelayMs ?? (onClick && onDoubleClick ? 200 : 0);

  const { onRowClick, onRowDoubleClick } = useTreeClickDelay({
    onClick,
    onDoubleClick,
    delayMs: delay,
    enabled: Boolean(onClick),
    shouldIgnoreClick,
  });

  const nodeStyle: CSSProperties = {
    paddingLeft: depth * indentStep + indentBase,
    ...style,
  };

  const rootClass = [
    "sidebar-tree-node",
    "tree-node",
    active ? "sidebar-tree-node--active tree-node--active" : "",
    muted ? "sidebar-tree-node--muted" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const labelNode =
    typeof label === "string" ? <span className="tree-label-name">{label}</span> : label;

  return (
    <div
      className={rootClass}
      style={nodeStyle}
      draggable={draggable}
      onClick={onClick ? onRowClick : undefined}
      onDoubleClick={onClick || onDoubleClick ? onRowDoubleClick : undefined}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      {...dataAttrs}
    >
      <span
        className={`sidebar-tree-arrow tree-arrow${hasChildren ? "" : " sidebar-tree-arrow--leaf tree-leaf"}${expanded ? " sidebar-tree-arrow--open tree-arrow--open" : ""}`}
        onClick={(event) => {
          if (!hasChildren) return;
          event.stopPropagation();
          onToggle();
        }}
      >
        {hasChildren ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="10" height="10">
            <path d="M9 18l6-6-6-6" />
          </svg>
        ) : (
          <span className="sidebar-tree-dot tree-dot" />
        )}
      </span>
      {icon ? <span className="sidebar-tree-icon tree-icon">{icon}</span> : null}
      {prefix}
      <span className="sidebar-tree-label tree-label">{labelNode}</span>
      {afterLabel}
      {trailing ? <div className="sidebar-tree-trailing tree-node-trailing">{trailing}</div> : null}
    </div>
  );
}

export function SidebarTreeRoot({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={`sidebar-tree-root ${className}`.trim()}>{children}</div>;
}

export function SidebarTreeEmpty({
  className = "",
  children,
  style,
}: {
  className?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div className={`sidebar-tree-empty ${className}`.trim()} style={style}>
      {children}
    </div>
  );
}
