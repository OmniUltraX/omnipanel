import {
  memo,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useI18n } from "../../../i18n";
import { StatusDot } from "../../../components/ui/primitives/StatusDot";
import {
  useDbConnectionRuntimeStore,
  resolveDbConnectionRuntimeStatus,
} from "../../../stores/dbConnectionRuntimeStore";
import { schemaNodeDeleteLabelKey } from "./schemaTreeNodeActions";
import type { SchemaTreeItem } from "./schemaTreeItem";
import { isLayoutPointerDragExcludedTarget } from "./schemaLayoutPointerDnD";
import {
  SidebarTreeNode,
  useSidebarTreeSelection,
} from "@/components/ui/sidebar-tree";
import type { TreeRowMouseEvent } from "@/components/ui/sidebar-tree";

export interface TreeNodeProps {
  item: SchemaTreeItem;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
  meta?: string;
  isPk?: boolean;
  isFk?: boolean;
  hasChildren: boolean;
  active?: boolean;
  /** 该节点已在工作区打开 Tab（非 active 的弱标记，用于视觉提示） */
  inTab?: boolean;
  /** 双击打开右侧面板（常驻 Tab） */
  onActivate?: () => void;
  /** 单击打开右侧面板（预览 Tab，斜体可替换） */
  onPreviewOpen?: () => void;
  onContextMenu?: (e: ReactMouseEvent) => void;
  iconUrl?: string | null;
  onMetaClick?: () => void;
  metaTitle?: string;
  pinActive?: boolean;
  onPinToggle?: () => void;
  /** 表节点：名称后显示的灰色注释 */
  labelComment?: string;
  /** 连接节点：是否启用（禁用与树折叠无关） */
  connectionEnabled?: boolean;
  /** 已检测部署方式时显示的服务器 tag */
  deploymentServerTag?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  refreshDisabled?: boolean;
  onDelete?: () => void;
  deleteDisabled?: boolean;
  /** 单击选中或双击打开时更新顶部路径 */
  onPathFocus?: () => void;
  layoutDraggable?: boolean;
  layoutDraggingSource?: boolean;
  dragOver?: boolean;
  onLayoutPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
}

export const TreeNode = memo(
  function TreeNode({
  item,
  depth,
  expanded,
  onToggle,
  meta,
  isPk,
  isFk,
  hasChildren,
  active,
  inTab,
  onActivate,
  onPreviewOpen,
  onContextMenu,
  iconUrl,
  onMetaClick,
  metaTitle,
  pinActive,
  onPinToggle,
  labelComment,
  connectionEnabled = true,
  deploymentServerTag,
  onRefresh,
  refreshing = false,
  refreshDisabled = false,
  onDelete,
  deleteDisabled = false,
  onPathFocus,
  layoutDraggable = false,
  layoutDraggingSource = false,
  dragOver = false,
  onLayoutPointerDown,
}: TreeNodeProps) {
  const { t } = useI18n();
  const selection = useSidebarTreeSelection();
  const { type, label } = item;
  const isConnection = type === "connection";
  const connId = item.connId;
  // 按连接订阅状态点，探测 online/offline 时不整树重渲
  const runtimeStatus = useDbConnectionRuntimeStore((s) =>
    isConnection && connId
      ? resolveDbConnectionRuntimeStatus(connId, connectionEnabled, s.statusByConnId)
      : "idle",
  );
  const connectionStateClass = isConnection
    ? connectionEnabled
      ? " tree-node--connection-enabled"
      : " tree-node--connection-disabled"
    : "";

  // 滚动帧里父组件会换新回调；用 ref 保住最新闭包，配合下方 memo 跳过重渲
  const handlersRef = useRef({
    onToggle,
    onActivate,
    onPreviewOpen,
    onContextMenu,
    onMetaClick,
    onPinToggle,
    onRefresh,
    onDelete,
    onPathFocus,
    onLayoutPointerDown,
  });
  handlersRef.current = {
    onToggle,
    onActivate,
    onPreviewOpen,
    onContextMenu,
    onMetaClick,
    onPinToggle,
    onRefresh,
    onDelete,
    onPathFocus,
    onLayoutPointerDown,
  };

  const ignoreClick = (target: EventTarget | null) => isLayoutPointerDragExcludedTarget(target);

  const dragClass = dragOver ? " tree-node--drag-over" : "";
  const layoutDragClass = layoutDraggable ? " tree-node--layout-draggable" : "";
  const layoutSourceClass = layoutDraggingSource ? " tree-node--layout-source-dragging" : "";

  const iconNode = (
    <>
      {type === "connection" ? (
        iconUrl ? (
          <img src={iconUrl} alt="" className="tree-engine-logo" draggable={false} />
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14">
            <rect x="2" y="2" width="20" height="8" rx="2" />
            <rect x="2" y="14" width="20" height="8" rx="2" />
            <circle cx="6" cy="6" r="1" fill="currentColor" />
            <circle cx="6" cy="18" r="1" fill="currentColor" />
          </svg>
        )
      ) : null}
      {type === "database" && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14">
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
        </svg>
      )}
      {type === "table" && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18M3 15h18M9 3v18" />
        </svg>
      )}
      {type === "view" && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14">
          <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      )}
      {type === "user" && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14">
          <circle cx="12" cy="8" r="3" />
          <path d="M5 20a7 7 0 0114 0" />
        </svg>
      )}
      {type === "routine" && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14">
          <path d="M10 3h4" />
          <path d="M12 3v6" />
          <path d="M6 14h12" />
          <path d="M8 18h8" />
        </svg>
      )}
      {type === "sql-query" && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M8 13h8M8 17h5" />
        </svg>
      )}
      {(type === "folder" || type === "connection-folder") && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
        </svg>
      )}
      {type === "column" && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14">
          <path d="M12 2v20" />
          <path d="M2 12h20" />
        </svg>
      )}
      {type === "index" && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14">
          <path d="M4 6h16M4 10h10M4 14h14M4 18h8" />
        </svg>
      )}
    </>
  );

  const trailingNode =
    meta || onRefresh || onDelete || onPinToggle ? (
      <>
        {meta ? (
          <span
            className={`tree-meta${onMetaClick ? " tree-meta--clickable" : ""}`}
            title={metaTitle}
            onClick={
              onMetaClick
                ? (event) => {
                    event.stopPropagation();
                    handlersRef.current.onMetaClick?.();
                  }
                : undefined
            }
          >
            {meta}
          </span>
        ) : null}
        {onRefresh || onDelete || onPinToggle ? (
          <div className="tree-node-actions">
            {onRefresh ? (
              <button
                type="button"
                className={`tree-action-btn${refreshing ? " tree-action-btn--busy" : ""}`}
                title={t("common.refresh")}
                aria-label={t("common.refresh")}
                disabled={refreshDisabled}
                onClick={(event) => {
                  event.stopPropagation();
                  handlersRef.current.onRefresh?.();
                }}
              >
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                  <path d="M2 8a6 6 0 0 1 10.5-3.9" />
                  <path d="M14 2v3h-3" />
                  <path d="M14 8a6 6 0 0 1-10.5 3.9" />
                  <path d="M2 14v-3h3" />
                </svg>
              </button>
            ) : null}
            {onDelete ? (
              <button
                type="button"
                className={`tree-action-btn tree-action-btn--danger${deleteDisabled ? " tree-action-btn--busy" : ""}`}
                title={t(schemaNodeDeleteLabelKey(item.type))}
                aria-label={t(schemaNodeDeleteLabelKey(item.type))}
                disabled={deleteDisabled}
                onClick={(event) => {
                  event.stopPropagation();
                  handlersRef.current.onDelete?.();
                }}
              >
                <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                  <path d="M2 4h12" />
                  <path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" />
                  <path d="M6 7v5M10 7v5" />
                  <path d="M3 4l.7 9.1a1 1 0 0 0 1 .9h6.6a1 1 0 0 0 1-.9L13 4" />
                </svg>
              </button>
            ) : null}
            {onPinToggle ? (
              <button
                type="button"
                className={`tree-action-btn tree-action-btn--pin${pinActive ? " tree-action-btn--active" : ""}`}
                title={
                  pinActive ? t("database.sidebar.unpinTable") : t("database.sidebar.pinTable")
                }
                aria-label={
                  pinActive ? t("database.sidebar.unpinTable") : t("database.sidebar.pinTable")
                }
                aria-pressed={pinActive}
                onClick={(event) => {
                  event.stopPropagation();
                  handlersRef.current.onPinToggle?.();
                }}
              >
                <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12" aria-hidden>
                  <path d="M9.5 1.5 8 3 6.5 1.5 5 3v4.6L2.8 9.8l-.3.3v1.4l.3.3L5 12.9V14l1.5-1.5L8 14l1.5-1.5L11 14v-1.1l2.2-2.2.3-.3v-1.4l-.3-.3L11 7.6V3L9.5 1.5Z" />
                </svg>
              </button>
            ) : null}
          </div>
        ) : null}
      </>
    ) : null;

  return (
    <SidebarTreeNode
      depth={depth}
      indentStep={16}
      indentBase={8}
      module="database"
      nodeType={type}
      treeKey={item.id}
      expanded={expanded}
      hasChildren={hasChildren}
      active={active}
      icon={iconNode}
      prefix={
        isConnection ? (
          <StatusDot
            status={runtimeStatus}
            title={
              !connectionEnabled
                ? t("database.sidebar.connectionDisabled")
                : runtimeStatus === "connecting"
                  ? t("common.loading")
                  : runtimeStatus === "online"
                    ? t("database.sidebar.connectionEnabled")
                    : runtimeStatus === "offline"
                      ? t("database.sidebar.connectionDisabled")
                      : t("database.sidebar.connectionDisconnected")
            }
          />
        ) : undefined
      }
      label={
        <>
          {isConnection && deploymentServerTag ? (
            <span className="server-tree-server-label">
              <span className="server-tree-server-name">{label}</span>
              <span
                className="sidebar-tag-chip badge badge-muted server-item__type-tag server-item__type-tag--onepanel"
                title={`${t("database.connectionInfo.deployment.server")}: ${deploymentServerTag}`}
              >
                {deploymentServerTag}
              </span>
            </span>
          ) : (
            <span className="tree-label-name">{label}</span>
          )}
          {labelComment ? (
            <span className="tree-label-comment" title={labelComment}>
              {labelComment}
            </span>
          ) : null}
        </>
      }
      afterLabel={
        <>
          {isPk ? <span className="tree-badge tree-badge--pk">PK</span> : null}
          {isFk ? <span className="tree-badge tree-badge--fk">FK</span> : null}
        </>
      }
      trailing={trailingNode}
      className={`tree-node--${type}${connectionStateClass}${dragClass}${layoutDragClass}${layoutSourceClass}${inTab ? " tree-node--in-tab" : ""}`}
      style={{ ["--tree-depth" as string]: depth }}
      dataAttrs={{
        "data-schema-item-type": type,
        "data-schema-node-id": item.id,
      }}
      onToggle={() => handlersRef.current.onToggle()}
      onSelect={(event: TreeRowMouseEvent) => {
        selection?.handleSelect(item.id, event);
        handlersRef.current.onPathFocus?.();
        // 修饰键只改选区。单击打开预览 Tab（斜体可替换），双击再升格常驻。
        if (event.ctrlKey || event.metaKey || event.shiftKey) {
          return;
        }
        handlersRef.current.onPreviewOpen?.();
      }}
      onActivate={() => {
        handlersRef.current.onPathFocus?.();
        handlersRef.current.onActivate?.();
      }}
      shouldIgnoreClick={ignoreClick}
      onPointerDown={(event) => {
        if (layoutDraggable) {
          handlersRef.current.onLayoutPointerDown?.(event);
        }
      }}
      onContextMenu={(event) => handlersRef.current.onContextMenu?.(event)}
    />
  );
},
  (prev, next) =>
    prev.item.id === next.item.id &&
    prev.item.label === next.item.label &&
    prev.depth === next.depth &&
    prev.expanded === next.expanded &&
    prev.hasChildren === next.hasChildren &&
    prev.active === next.active &&
    prev.inTab === next.inTab &&
    prev.meta === next.meta &&
    prev.metaTitle === next.metaTitle &&
    prev.isPk === next.isPk &&
    prev.isFk === next.isFk &&
    prev.labelComment === next.labelComment &&
    prev.connectionEnabled === next.connectionEnabled &&
    prev.deploymentServerTag === next.deploymentServerTag &&
    prev.iconUrl === next.iconUrl &&
    prev.pinActive === next.pinActive &&
    prev.refreshing === next.refreshing &&
    prev.refreshDisabled === next.refreshDisabled &&
    prev.deleteDisabled === next.deleteDisabled &&
    prev.layoutDraggable === next.layoutDraggable &&
    prev.layoutDraggingSource === next.layoutDraggingSource &&
    prev.dragOver === next.dragOver &&
    Boolean(prev.onMetaClick) === Boolean(next.onMetaClick) &&
    Boolean(prev.onRefresh) === Boolean(next.onRefresh) &&
    Boolean(prev.onDelete) === Boolean(next.onDelete) &&
    Boolean(prev.onPinToggle) === Boolean(next.onPinToggle) &&
    Boolean(prev.onActivate) === Boolean(next.onActivate) &&
    Boolean(prev.onPreviewOpen) === Boolean(next.onPreviewOpen) &&
    Boolean(prev.onLayoutPointerDown) === Boolean(next.onLayoutPointerDown),
);
