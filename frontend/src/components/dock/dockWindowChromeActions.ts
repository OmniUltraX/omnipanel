import type { ReactNode } from "react";

export type DockWindowChromeMode = "drag" | "controls" | "both";

export interface DockWindowChromeActionsProps {
  mode: DockWindowChromeMode;
  leftActions?: ReactNode;
}
