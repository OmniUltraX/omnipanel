import {
  BrandIconImg,
  resolvePanelBrandIcon,
  type BrandIconKind,
} from "../brandIcons";

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  width: 13,
  height: 13,
  "aria-hidden": true,
} as const;

export type ServerTreeIconKind =
  | "server"
  | "bt"
  | "1panel"
  | "aliyun"
  | "tencent"
  | "apps"
  | "websites"
  | "certificates"
  | "cronjobs"
  | "databases"
  | "website";

type ServerTreeBrandIconKind = Extract<BrandIconKind, ServerTreeIconKind>;

function isBrandKind(kind: ServerTreeIconKind): kind is ServerTreeBrandIconKind {
  return kind === "bt" || kind === "1panel" || kind === "aliyun" || kind === "tencent";
}

export function serverTreeIconKindForPanel(
  serviceType: string | null | undefined,
): ServerTreeIconKind {
  return resolvePanelBrandIcon(serviceType) ?? "server";
}

export function ServerTreeIcon({ kind }: { kind: ServerTreeIconKind }) {
  if (isBrandKind(kind)) {
    return <BrandIconImg kind={kind} />;
  }

  switch (kind) {
    case "server":
      return (
        <svg {...iconProps}>
          <rect x="2" y="2" width="20" height="8" rx="2" />
          <rect x="2" y="14" width="20" height="8" rx="2" />
          <circle cx="6" cy="6" r="1" fill="currentColor" stroke="none" />
          <circle cx="6" cy="18" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case "apps":
      return (
        <svg {...iconProps}>
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      );
    case "websites":
      return (
        <svg {...iconProps}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18" />
          <path d="M12 3a14 14 0 010 18" />
          <path d="M12 3a14 14 0 000 18" />
        </svg>
      );
    case "certificates":
      return (
        <svg {...iconProps}>
          <rect x="5" y="3" width="14" height="18" rx="2" />
          <path d="M9 8h6" />
          <path d="M9 12h6" />
          <path d="M9 16h3" />
        </svg>
      );
    case "cronjobs":
      return (
        <svg {...iconProps}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case "databases":
      return (
        <svg {...iconProps}>
          <ellipse cx="12" cy="6" rx="7" ry="2.4" />
          <path d="M5 6v8c0 1.3 3.1 2.4 7 2.4s7-1.1 7-2.4V6" />
          <path d="M5 10c0 1.3 3.1 2.4 7 2.4s7-1.1 7-2.4" />
        </svg>
      );
    case "website":
      return (
        <svg {...iconProps}>
          <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
        </svg>
      );
    default:
      return null;
  }
}

export function serverTreeNodeClassName(
  kind: ServerTreeIconKind,
  extraClass?: string,
): string {
  return ["server-tree-node", `server-tree-node--${kind}`, extraClass].filter(Boolean).join(" ");
}
