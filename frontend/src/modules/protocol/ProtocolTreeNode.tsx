import type { CSSProperties, MouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";

export type ProtocolTreeNodeKind = "folder" | "request";

interface ProtocolTreeNodeProps {
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
  onClick?: () => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
}

export function ProtocolTreeNode({
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
  onClick,
  onPointerDown,
  onContextMenu,
}: ProtocolTreeNodeProps) {
  const indent = depth * 16 + 8;
  const nodeStyle: CSSProperties = { paddingLeft: indent };

  const handleRowClick = () => {
    if (kind === "folder") {
      onToggle();
      return;
    }
    onClick?.();
  };

  return (
    <div
      className={`tree-node tree-node--${kind}${active ? " tree-node--active" : ""} tree-node--layout-draggable${className}`}
      style={nodeStyle}
      data-tree-key={dataTreeKey}
      data-tree-kind={kind}
      onClick={handleRowClick}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
    >
      <span
        className={`tree-arrow${hasChildren ? "" : " tree-leaf"}${expanded ? " tree-arrow--open" : ""}`}
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
          <span className="tree-dot" />
        )}
      </span>
      {icon ? <span className="tree-icon">{icon}</span> : null}
      {prefix}
      <span className="tree-label">
        <span className="tree-label-name">{label}</span>
      </span>
    </div>
  );
}
