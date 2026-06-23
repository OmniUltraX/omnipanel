import { Group } from "react-resizable-panels";
import type { GroupProps } from "react-resizable-panels";

type DockLayoutProps = {
  children: React.ReactNode;
  direction?: "horizontal" | "vertical";
  className?: string;
  defaultLayout?: GroupProps["defaultLayout"];
  onLayoutChange?: GroupProps["onLayoutChange"];
  onLayoutChanged?: GroupProps["onLayoutChanged"];
};

export function DockLayout({
  children,
  direction = "horizontal",
  className,
  defaultLayout,
  onLayoutChange,
  onLayoutChanged,
}: DockLayoutProps) {
  return (
    <Group
      orientation={direction}
      className={`dock-layout dock-layout--${direction}${className ? ` ${className}` : ""}`}
      defaultLayout={defaultLayout}
      onLayoutChange={onLayoutChange}
      onLayoutChanged={onLayoutChanged}
    >
      {children}
    </Group>
  );
}
