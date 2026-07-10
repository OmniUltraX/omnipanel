import type { ServerDetailTab } from "./ServerWorkspace";

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
  | "processes"
  | "apps"
  | "websites"
  | "certificates"
  | "app"
  | "website"
  | "certificate";

export function ServerTreeIcon({ kind }: { kind: ServerTreeIconKind }) {
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
    case "processes":
      return (
        <svg {...iconProps}>
          <path d="M9 6h11M9 12h11M9 18h11" />
          <circle cx="5" cy="6" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="5" cy="18" r="1.2" fill="currentColor" stroke="none" />
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
          <path d="M12 3 4 6v6c0 4.4 3.6 8 8 9 4.4-1 8-4.6 8-9V6l-8-3z" />
          <path d="M9.5 12.5 11 14l3.5-3.5" />
        </svg>
      );
    case "app":
      return (
        <svg {...iconProps}>
          <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
          <path d="M3.3 7.7 12 12l8.7-4.3M12 22V12" />
        </svg>
      );
    case "website":
      return (
        <svg {...iconProps}>
          <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
        </svg>
      );
    case "certificate":
      return (
        <svg {...iconProps}>
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M8 13h8M8 17h5" />
        </svg>
      );
    default:
      return null;
  }
}

export function serverCategoryIconKind(
  categoryId: Extract<ServerDetailTab, "apps" | "websites" | "certificates">,
): ServerTreeIconKind {
  return categoryId;
}

export function serverItemIconKind(
  categoryId: Extract<ServerDetailTab, "apps" | "websites" | "certificates">,
): ServerTreeIconKind {
  if (categoryId === "apps") return "app";
  if (categoryId === "websites") return "website";
  return "certificate";
}

export function serverTreeNodeClassName(
  kind: ServerTreeIconKind,
  extraClass?: string,
): string {
  return ["server-tree-node", `server-tree-node--${kind}`, extraClass].filter(Boolean).join(" ");
}
