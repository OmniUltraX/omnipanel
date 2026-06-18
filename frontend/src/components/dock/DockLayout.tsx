import { Group } from "react-resizable-panels";
import type { GroupProps } from "react-resizable-panels";

type DockLayoutProps = {
  children: React.ReactNode;
  direction?: "horizontal" | "vertical";
  className?: string;
  onLayoutChange?: GroupProps["onLayoutChange"];
  onLayoutChanged?: GroupProps["onLayoutChanged"];
};

export function DockLayout({
  children,
  direction = "horizontal",
  className,
  onLayoutChange,
  onLayoutChanged,
}: DockLayoutProps) {
  return (
    <Group
      orientation={direction}
      className={`dock-layout${className ? ` ${className}` : ""}`}
      onLayoutChange={onLayoutChange}
      onLayoutChanged={onLayoutChanged}
    >
      {children}
    </Group>
  );
}
