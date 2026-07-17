/** 模块分段 Tab / 顶栏 segment 模式图标（与 server 侧栏 ServerTreeIcon 视觉一致） */
export type SegmentTabIconKind =
  | "server"
  | "monitor"
  | "processes"
  | "apps"
  | "websites"
  | "certificates"
  | "cronjobs"
  /** @deprecated 使用 apps */
  | "services"
  | "logs";

const SEGMENT_TAB_ICON_KINDS = new Set<string>([
  "server",
  "monitor",
  "processes",
  "apps",
  "websites",
  "certificates",
  "cronjobs",
  "services",
  "logs",
]);

export function isSegmentTabIconKind(icon: string): icon is SegmentTabIconKind {
  return SEGMENT_TAB_ICON_KINDS.has(icon);
}

export function SegmentTabIcon({
  icon,
  size = 12,
}: {
  icon: SegmentTabIconKind;
  size?: number;
}) {
  const props = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    width: size,
    height: size,
    "aria-hidden": true as const,
  };

  switch (icon) {
    case "server":
      return (
        <svg {...props}>
          <rect x="2" y="2" width="20" height="8" rx="2" />
          <rect x="2" y="14" width="20" height="8" rx="2" />
          <circle cx="6" cy="6" r="1" fill="currentColor" stroke="none" />
          <circle cx="6" cy="18" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case "monitor":
      return (
        <svg {...props}>
          <path d="M3 3v18h18" />
          <path d="m19 9-5 5-4-4-3 3" />
        </svg>
      );
    case "processes":
      return (
        <svg {...props}>
          <path d="M9 6h11M9 12h11M9 18h11" />
          <circle cx="5" cy="6" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="5" cy="18" r="1.2" fill="currentColor" stroke="none" />
        </svg>
      );
    case "apps":
    case "services":
      return (
        <svg {...props}>
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      );
    case "websites":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a14 14 0 010 18" />
          <path d="M12 3a14 14 0 000 18" />
        </svg>
      );
    case "certificates":
      return (
        <svg {...props}>
          <rect x="5" y="3" width="14" height="18" rx="2" />
          <path d="M9 8h6" />
          <path d="M9 12h6" />
          <path d="M9 16h3" />
        </svg>
      );
    case "cronjobs":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case "logs":
      return (
        <svg {...props}>
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
      );
    default:
      return null;
  }
}
