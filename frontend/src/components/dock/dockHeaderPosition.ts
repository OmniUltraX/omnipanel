import type { DockviewApi } from "dockview-react";

export type DockHeaderPosition = "top" | "bottom" | "left" | "right";

export function syncGroupHeaderPosition(
  api: DockviewApi,
  position: DockHeaderPosition,
): void {
  for (const group of api.groups) {
    if (group.api.getHeaderPosition() !== position) {
      group.api.setHeaderPosition(position);
    }
  }
}
