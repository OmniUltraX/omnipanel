import {
  memo,
  useMemo,
  useState,
  type CSSProperties,
  type DragEventHandler,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/ContextMenu";
import { useI18n } from "@/i18n";
import { type TreeRowMouseEvent } from "./useTreeClickDelay";
import { useSidebarTreeNodeSelection } from "./SidebarTreeSelectionProvider";
import { buildSidebarTreeContextMenuItems } from "./buildSidebarTreeContextMenuItems";
import type { SidebarTreeModule } from "./sidebarTreeTypes";
import "./sidebar-tree.css";

function defaultShouldIgnoreClick(target: EventTarget | null): boolean {
  return Boolean((target as HTMLElement | null)?.closest(".tree-action-btn"));
}

function SidebarTreeRefreshButton({
  title,
  busy,
  disabled,
  onRefresh,
}: {
  title: string;
  busy?: boolean;
  disabled?: boolean;
  onRefresh: () => void;
}) {
  return (
    <button
      type="button"
      className={`tree-action-btn${busy ? " tree-action-btn--busy" : ""}`}
      title={title}
      aria-label={title}
      disabled={disabled || busy}
      onClick={(event) => {
        event.stopPropagation();
        onRefresh();
      }}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        aria-hidden
      >
        <path d="M2 8a6 6 0 0 1 10.5-3.9" />
        <path d="M14 2v3h-3" />
        <path d="M14 8a6 6 0 0 1-10.5 3.9" />
        <path d="M2 14v-3h3" />
      </svg>
    </button>
  );
}

export type SidebarTreeNodeProps = {
  /** 所属模块 */
  module: SidebarTreeModule;
  /** 节点类型（模块内语义，如 connection / folder / table） */
  nodeType: string;
  depth?: number;
  indentStep?: number;
  indentBase?: number;
  expanded: boolean;
  hasChildren: boolean;
  /** 当前节点是否已在右侧工作区打开 */
  active?: boolean;
  /** 单击选中（支持 Shift / Ctrl 多选时由父级维护） */
  selected?: boolean;
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
  /** 单击：选中节点（不打开面板） */
  onSelect?: (event: TreeRowMouseEvent) => void;
  /** 双击：打开右侧常驻面板 */
  onActivate?: (event: TreeRowMouseEvent) => void;
  /** @deprecated 使用 onSelect */
  onClick?: (event: TreeRowMouseEvent) => void;
  /** @deprecated 使用 onActivate */
  onDoubleClick?: (event: TreeRowMouseEvent) => void;
  /** @deprecated 单击预览延迟已废弃；现为单击选中 / 双击打开常驻 */
  clickDelayMs?: number;
  shouldIgnoreClick?: (target: EventTarget | null) => boolean;
  /** 右侧刷新；未提供时不渲染刷新按钮 */
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshDisabled?: boolean;
  refreshTitle?: string;
  /** 右键菜单：重命名 */
  onRename?: () => void;
  /** 右键菜单：删除 */
  onDelete?: () => void;
  renameLabel?: string;
  deleteLabel?: string;
  renameDisabled?: boolean;
  deleteDisabled?: boolean;
  /** 附加右键菜单项（显示在重命名 / 删除之前） */
  contextMenuItems?: ContextMenuItem[];
  /** 禁用内置右键菜单 */
  contextMenuDisabled?: boolean;
  /** 自定义右键逻辑（在内置菜单之前触发） */
  onContextMenu?: (event: TreeRowMouseEvent) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /** 透传 data-* 属性 */
  dataAttrs?: Record<string, string>;
  /** 在 SidebarTreeSelectionProvider 内登记 key，自动接入 Shift/Ctrl 多选 */
  treeKey?: string;
};

export const SidebarTreeNode = memo(function SidebarTreeNode({
  module,
  nodeType,
  depth = 0,
  indentStep = 16,
  indentBase = 8,
  expanded,
  hasChildren,
  active = false,
  selected = false,
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
  onSelect,
  onActivate,
  onClick,
  onDoubleClick,
  shouldIgnoreClick,
  onRefresh,
  refreshing = false,
  refreshDisabled = false,
  refreshTitle,
  onRename,
  onDelete,
  renameLabel,
  deleteLabel,
  renameDisabled,
  deleteDisabled,
  contextMenuItems,
  contextMenuDisabled = false,
  onContextMenu,
  onPointerDown,
  dataAttrs,
  treeKey,
}: SidebarTreeNodeProps) {
  const { t } = useI18n();
  const [contextMenuPos, setContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const selection = useSidebarTreeNodeSelection(treeKey);
  const resolvedSelected =
    selected || Boolean(treeKey && selection?.isSelected(treeKey));
  const selectHandler =
    onSelect ??
    onClick ??
    (treeKey && selection
      ? (event: TreeRowMouseEvent) => selection.handleSelect(treeKey, event)
      : undefined);
  const activateHandler = onActivate ?? onDoubleClick;

  const resolveShouldIgnoreClick = shouldIgnoreClick ?? defaultShouldIgnoreClick;

  const handleClick = selectHandler
    ? (event: TreeRowMouseEvent) => {
        if (resolveShouldIgnoreClick(event.target)) return;
        selectHandler(event);
      }
    : undefined;

  const handleDoubleClick = activateHandler
    ? (event: TreeRowMouseEvent) => {
        if (resolveShouldIgnoreClick(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        activateHandler(event);
      }
    : undefined;

  const builtInContextMenuItems = useMemo(
    () =>
      buildSidebarTreeContextMenuItems({
        renameLabel: renameLabel ?? t("sidebarTree.rename"),
        deleteLabel: deleteLabel ?? t("sidebarTree.delete"),
        onRename,
        onDelete,
        renameDisabled,
        deleteDisabled,
        extraItems: contextMenuItems,
      }),
    [
      renameLabel,
      deleteLabel,
      onRename,
      onDelete,
      renameDisabled,
      deleteDisabled,
      contextMenuItems,
      t,
    ],
  );

  const hasBuiltInContextMenu = builtInContextMenuItems.length > 0 && !contextMenuDisabled;

  const nodeStyle: CSSProperties = {
    paddingLeft: depth * indentStep + indentBase,
    ...style,
  };

  const rootClass = [
    "sidebar-tree-node",
    "tree-node",
    active ? "sidebar-tree-node--active tree-node--active" : "",
    resolvedSelected ? "sidebar-tree-node--selected tree-node--selected" : "",
    muted ? "sidebar-tree-node--muted" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const labelNode =
    typeof label === "string" ? <span className="tree-label-name">{label}</span> : label;

  const handleContextMenu = (event: TreeRowMouseEvent) => {
    onContextMenu?.(event);
    if (!hasBuiltInContextMenu) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setContextMenuPos({ x: event.clientX, y: event.clientY });
  };

  const mergedDataAttrs: Record<string, string> = {
    "data-sidebar-tree-module": module,
    "data-sidebar-tree-node-type": nodeType,
    ...dataAttrs,
  };

  const refreshTitleResolved = refreshTitle ?? t("common.refresh");

  const trailingNode =
    trailing || onRefresh ? (
      <div className="sidebar-tree-trailing tree-node-trailing">
        {trailing}
        {onRefresh ? (
          <div className="tree-node-actions">
            <SidebarTreeRefreshButton
              title={refreshTitleResolved}
              busy={refreshing}
              disabled={refreshDisabled}
              onRefresh={onRefresh}
            />
          </div>
        ) : null}
      </div>
    ) : null;

  return (
    <>
      <div
        className={rootClass}
        style={nodeStyle}
        draggable={draggable}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
        onContextMenu={handleContextMenu}
        onPointerDown={onPointerDown}
        {...mergedDataAttrs}
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
        {trailingNode}
      </div>
      {contextMenuPos ? (
        <ContextMenu
          items={builtInContextMenuItems}
          position={contextMenuPos}
          onClose={() => setContextMenuPos(null)}
        />
      ) : null}
    </>
  );
});

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
