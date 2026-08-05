import type { CSSProperties, MouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import {
  SidebarTreeNode,
  useSidebarTreeSelection,
  type TreeRowMouseEvent,
  type SidebarTreeModule,
} from "@/components/ui/sidebar-tree";

export type ProtocolTreeNodeKind = "folder" | "request" | "entry";

interface ProtocolTreeNodeProps {
  module?: SidebarTreeModule;
  depth: number;
  kind: ProtocolTreeNodeKind;
  expanded: boolean;
  hasChildren: boolean;
  active?: boolean;
  label: ReactNode;
  icon?: ReactNode;
  prefix?: ReactNode;
  /** 标题右侧附加内容（如 HTTP METHOD tag） */
  afterLabel?: ReactNode;
  trailing?: ReactNode;
  dataTreeKey: string;
  className?: string;
  onToggle: () => void;
  /** 单击：打开临时预览面板（多选仍由 SidebarTreeSelection 处理） */
  onSelect?: (event: TreeRowMouseEvent) => void;
  /** 双击：打开 / 升格为常驻面板 */
  onActivate?: (event: TreeRowMouseEvent) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
}

export function ProtocolTreeNode({
  module = "protocol",
  depth,
  kind,
  expanded,
  hasChildren,
  active = false,
  label,
  icon,
  prefix,
  afterLabel,
  trailing,
  dataTreeKey,
  className = "",
  onToggle,
  onSelect,
  onActivate,
  onPointerDown,
  onContextMenu,
}: ProtocolTreeNodeProps) {
  const selection = useSidebarTreeSelection();
  const nodeStyle: CSSProperties = {
    ["--tree-depth" as string]: depth,
  };

  return (
    <SidebarTreeNode
      depth={depth}
      module={module}
      nodeType={kind}
      indentStep={16}
      indentBase={8}
      expanded={expanded}
      hasChildren={hasChildren}
      active={active}
      treeKey={dataTreeKey}
      label={<span className="tree-label-name">{label}</span>}
      icon={icon}
      prefix={prefix}
      afterLabel={afterLabel}
      trailing={trailing}
      className={`tree-node--${kind} tree-node--layout-draggable${className}`}
      style={nodeStyle}
      dataAttrs={{
        "data-tree-key": dataTreeKey,
        "data-tree-kind": kind,
      }}
      onToggle={onToggle}
      onSelect={
        onSelect || selection
          ? (event: TreeRowMouseEvent) => {
              selection?.handleSelect(dataTreeKey, event);
              onSelect?.(event);
            }
          : undefined
      }
      onActivate={onActivate}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
    />
  );
}
