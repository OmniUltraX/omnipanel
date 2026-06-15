export type DockTabIconKind = "sql" | "table";

const iconProps = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
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

  return (
    <svg {...iconProps}>
      <path d="M4 3h8l2 2v8H4V3z" />
      <path d="M12 3v2h2M6 8h4M6 10.5h2.5" />
    </svg>
  );
}
