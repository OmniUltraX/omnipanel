import type { SVGProps } from "react";

/**
 * 左侧栏统一图标集。
 *
 * 规范（见 openspec `module-sidebar-icons`）：
 * - 所有 kind 固定 14×14 / stroke 1.8，不接受 size prop；
 * - 模块禁止再自绘同语义图标（`function FolderIcon` 私有实现一律删除）。
 */
export type SidebarIconKind =
  | "folder"
  | "document"
  | "connection"
  | "host"
  | "database"
  | "container"
  | "key"
  | "tunnel";

const baseProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  width: 14,
  height: 14,
  "aria-hidden": true,
} as const satisfies SVGProps<SVGSVGElement>;

export function SidebarIcon({ kind }: { kind: SidebarIconKind }) {
  switch (kind) {
    case "folder":
      return (
        <svg {...baseProps}>
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
        </svg>
      );
    case "document":
      return (
        <svg {...baseProps}>
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
        </svg>
      );
    case "connection":
      return (
        <svg {...baseProps}>
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </svg>
      );
    case "host":
      return (
        <svg {...baseProps}>
          <rect x="2" y="2" width="20" height="8" rx="2" />
          <rect x="2" y="14" width="20" height="8" rx="2" />
          <circle cx="6" cy="6" r="1" fill="currentColor" stroke="none" />
          <circle cx="6" cy="18" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case "database":
      return (
        <svg {...baseProps}>
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M3 5v14a9 3 0 0 0 18 0V5" />
          <path d="M3 12a9 3 0 0 0 18 0" />
        </svg>
      );
    case "container":
      return (
        <svg {...baseProps}>
          <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <path d="M3.3 7 12 12l8.7-5" />
          <path d="M12 22V12" />
        </svg>
      );
    case "key":
      return (
        <svg {...baseProps}>
          <circle cx="7.5" cy="15.5" r="4.5" />
          <path d="m11 12 9-9" />
          <path d="m15.5 7.5 2 2" />
        </svg>
      );
    case "tunnel":
      return (
        <svg {...baseProps}>
          <path d="M8 3 4 7l4 4" />
          <path d="M4 7h16" />
          <path d="m16 21 4-4-4-4" />
          <path d="M20 17H4" />
        </svg>
      );
  }
}
