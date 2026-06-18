import { Group } from "react-resizable-panels";
import type { GroupProps } from "react-resizable-panels";

type DockLayoutProps = {
  children: React.ReactNode;
  direction?: "horizontal" | "vertical";
  className?: string;
  onLayoutChanged?: GroupProps["onLayoutChanged"];
};

export function DockLayout({
  children,
  direction = "horizontal",
  className,
  onLayoutChanged,
}: DockLayoutProps) {
  return (
    <Group
      orientation={direction}
      className={`dock-layout${className ? ` ${className}` : ""}`}
      onLayoutChanged={onLayoutChanged}
    >
      {children}
    </Group>
  );
}
