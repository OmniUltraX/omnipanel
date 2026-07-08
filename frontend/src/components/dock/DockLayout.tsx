import { Group } from "react-resizable-panels";
import type { GroupProps } from "react-resizable-panels";
import { useModuleVisibility } from "../../lib/moduleVisibility";

type DockLayoutProps = {
  children: React.ReactNode;
  direction?: "horizontal" | "vertical";
  className?: string;
  defaultLayout?: GroupProps["defaultLayout"];
  onLayoutChange?: GroupProps["onLayoutChange"];
  onLayoutChanged?: GroupProps["onLayoutChanged"];
  /** 显式禁用；未指定时跟随 ModuleVisibility（叠层非激活模块自动禁用） */
  disabled?: boolean;
};

export function DockLayout({
  children,
  direction = "horizontal",
  className,
  defaultLayout,
  onLayoutChange,
  onLayoutChanged,
  disabled: disabledProp,
}: DockLayoutProps) {
  const { active: moduleActive } = useModuleVisibility();
  const disabled = disabledProp ?? !moduleActive;

  return (
    <Group
      orientation={direction}
      disabled={disabled}
      className={`dock-layout dock-layout--${direction}${className ? ` ${className}` : ""}`}
      defaultLayout={defaultLayout}
      onLayoutChange={onLayoutChange}
      onLayoutChanged={onLayoutChanged}
      resizeTargetMinimumSize={{ fine: 10, coarse: 20 }}
    >
      {children}
    </Group>
  );
}
