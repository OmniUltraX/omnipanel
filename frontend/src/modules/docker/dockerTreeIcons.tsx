import type { DockerTreeCategory } from "./dockerSidebarNav";
import {
  ComposeStackIcon,
  ContainerIcon,
  DockerWhaleIcon,
  ImageLayersIcon,
} from "./icons";

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  width: 13,
  height: 13,
  "aria-hidden": true,
} as const;

export type DockerTreeIconKind =
  | "connection"
  | DockerTreeCategory
  | "image"
  | "container"
  | "network"
  | "volume"
  | "service-group";

export function DockerTreeIcon({ kind }: { kind: DockerTreeIconKind }) {
  switch (kind) {
    case "connection":
      return <DockerWhaleIcon size={13} />;
    case "images":
      return <ImageLayersIcon size={13} />;
    case "containers":
      return <ContainerIcon size={13} />;
    case "networks":
      return (
        <svg {...iconProps}>
          <circle cx="12" cy="5" r="2" />
          <circle cx="5" cy="19" r="2" />
          <circle cx="19" cy="19" r="2" />
          <path d="M12 7v4M8.5 15.5 12 11M15.5 15.5 12 11" />
        </svg>
      );
    case "volumes":
      return (
        <svg {...iconProps}>
          <ellipse cx="12" cy="6" rx="8" ry="2.5" />
          <path d="M4 6v12c0 1.38 3.58 2.5 8 2.5s8-1.12 8-2.5V6" />
          <path d="M4 12c0 1.38 3.58 2.5 8 2.5s8-1.12 8-2.5" />
        </svg>
      );
    case "image":
      return <ImageLayersIcon size={13} />;
    case "container":
      return <ContainerIcon size={13} />;
    case "service-group":
      return <ComposeStackIcon size={13} />;
    case "network":
      return (
        <svg {...iconProps}>
          <circle cx="12" cy="5" r="2" />
          <circle cx="5" cy="19" r="2" />
          <circle cx="19" cy="19" r="2" />
          <path d="M12 7v4M8.5 15.5 12 11M15.5 15.5 12 11" />
        </svg>
      );
    case "volume":
      return (
        <svg {...iconProps}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M8 9h8M8 13h5" />
        </svg>
      );
    default:
      return null;
  }
}

export function dockerCategoryIconKind(category: DockerTreeCategory): DockerTreeIconKind {
  return category;
}

export function dockerItemIconKind(category: DockerTreeCategory): DockerTreeIconKind {
  switch (category) {
    case "images":
      return "image";
    case "containers":
      return "container";
    case "networks":
      return "network";
    case "volumes":
      return "volume";
    default:
      return "container";
  }
}

export function dockerTreeNodeClassName(
  kind: DockerTreeIconKind,
  extraClass?: string,
): string {
  return ["server-tree-node", `docker-tree-node--${kind}`, extraClass].filter(Boolean).join(" ");
}
