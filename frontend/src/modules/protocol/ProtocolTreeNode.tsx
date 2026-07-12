import type { CSSProperties, MouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { SidebarTreeNode, type TreeRowMouseEvent, type SidebarTreeModule } from "@/components/ui/sidebar-tree";

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
  dataTreeKey: string;
  className?: string;
  onToggle: () => void;
  onActivate?: () => void;
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
  dataTreeKey,
  className = "",
  onToggle,
  onActivate,
  onPointerDown,
  onContextMenu,
}: ProtocolTreeNodeProps) {
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
      className={`tree-node--${kind} tree-node--layout-draggable${className}`}
      style={nodeStyle}
      dataAttrs={{
        "data-tree-key": dataTreeKey,
        "data-tree-kind": kind,
      }}
      onToggle={onToggle}
      onActivate={onActivate ? (_event: TreeRowMouseEvent) => onActivate() : undefined}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
    />
  );
}
