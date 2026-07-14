export type DockTabIconKind =
  | "sql"
  | "table"
  | "database"
  | "file-local"
  | "file-ftp"
  | "file-sftp"
  | "file-s3"
  | "docker-connection"
  | "docker-container"
  | "docker-containers"
  | "docker-images"
  | "docker-networks"
  | "docker-volumes"
  | "docker-compose";

const iconProps = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  width: 14,
  height: 14,
  "aria-hidden": true,
} as const;

/** Docker Tab：与侧栏树视觉一致，使用 24 坐标系缩放到 14×14 */
const dockerIconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  width: 14,
  height: 14,
  "aria-hidden": true,
} as const;

export function DockTabIcon({ kind }: { kind: DockTabIconKind }) {
  if (kind === "table") {
    return (
      <svg {...iconProps}>
        <rect x="2" y="3" width="12" height="10" rx="1" />
        <path d="M2 7h12M6 3v10M10 3v10" />
      </svg>
    );
  }

  if (kind === "database") {
    return (
      <svg {...iconProps}>
        <ellipse cx="8" cy="4.5" rx="5" ry="2" />
        <path d="M3 4.5v7c0 1.1 2.2 2 5 2s5-.9 5-2v-7" />
        <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
      </svg>
    );
  }

  if (kind === "file-local") {
    return (
      <svg {...iconProps}>
        <rect x="2" y="2" width="12" height="12" rx="1" />
        <path d="M5 6h6M5 8h4" />
      </svg>
    );
  }

  if (kind === "file-ftp") {
    return (
      <svg {...iconProps}>
        <rect x="2" y="3" width="12" height="10" rx="1" />
        <path d="M5 7h6M5 9h4" />
      </svg>
    );
  }

  if (kind === "file-sftp") {
    return (
      <svg {...iconProps}>
        <rect x="3" y="5" width="10" height="8" rx="1" />
        <path d="M5 5V4a3 3 0 016 0v1" />
        <circle cx="8" cy="10" r="1" />
      </svg>
    );
  }

  if (kind === "file-s3") {
    return (
      <svg {...iconProps}>
        <path d="M8 2L2 5v6l6 3 6-3V5z" />
        <path d="M2 5l6 3 6-3" />
      </svg>
    );
  }

  if (kind === "docker-connection") {
    return (
      <svg {...dockerIconProps}>
        <rect x="2" y="7" width="6" height="5" rx="1" />
        <rect x="10" y="7" width="6" height="5" rx="1" />
        <rect x="18" y="7" width="4" height="5" rx="1" />
        <rect x="6" y="2" width="6" height="5" rx="1" />
        <path d="M2 17h20c0 2.76-4.48 5-10 5S2 19.76 2 17z" />
      </svg>
    );
  }

  if (kind === "docker-container" || kind === "docker-containers") {
    return (
      <svg {...dockerIconProps} strokeWidth={2}>
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
        <line x1="12" y1="22.08" x2="12" y2="12" />
      </svg>
    );
  }

  if (kind === "docker-images") {
    return (
      <svg {...dockerIconProps} strokeWidth={2}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    );
  }

  if (kind === "docker-networks") {
    return (
      <svg {...dockerIconProps}>
        <circle cx="12" cy="5" r="2" />
        <circle cx="5" cy="19" r="2" />
        <circle cx="19" cy="19" r="2" />
        <path d="M12 7v4M8.5 15.5 12 11M15.5 15.5 12 11" />
      </svg>
    );
  }

  if (kind === "docker-volumes") {
    return (
      <svg {...dockerIconProps}>
        <ellipse cx="12" cy="6" rx="8" ry="2.5" />
        <path d="M4 6v12c0 1.38 3.58 2.5 8 2.5s8-1.12 8-2.5V6" />
        <path d="M4 12c0 1.38 3.58 2.5 8 2.5s8-1.12 8-2.5" />
      </svg>
    );
  }

  if (kind === "docker-compose") {
    return (
      <svg {...dockerIconProps} strokeWidth={2}>
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 12l10 5 10-5" />
        <path d="M2 17l10 5 10-5" />
      </svg>
    );
  }

  return (
    <svg {...iconProps}>
      <path d="M4 3h8l2 2v8H4V3z" />
      <path d="M12 3v2h2M6 8h4M6 10.5h2.5" />
    </svg>
  );
}
