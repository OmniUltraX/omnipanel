import type { DashboardIconKind } from "./dashboardModel";

type DashboardIconProps = {
  kind: DashboardIconKind;
};

export function DashboardIcon({ kind }: DashboardIconProps) {
  switch (kind) {
    case "terminal":
      return (
        <>
          <path d="M4 17l6-6-6-6" />
          <path d="M12 19h8" />
        </>
      );
    case "database":
      return (
        <>
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3" />
          <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
        </>
      );
    case "ssh":
    case "server":
      return (
        <>
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <path d="M8 21h8M12 17v4" />
        </>
      );
    case "docker":
      return (
        <>
          <rect x="2" y="7" width="6" height="5" rx="1" />
          <rect x="10" y="7" width="6" height="5" rx="1" />
        </>
      );
    case "files":
      return <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />;
    case "workflow":
      return (
        <>
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
        </>
      );
    default:
      return <circle cx="12" cy="12" r="8" />;
  }
}
