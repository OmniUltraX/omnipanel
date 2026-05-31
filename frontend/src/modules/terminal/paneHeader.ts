import type { WorkspaceResource } from "../../lib/resourceRegistry";
import type { TerminalPane } from "../../stores/terminalStore";

export function formatPaneHeaderTitle(
  resource: WorkspaceResource | null,
  pane: TerminalPane,
): string {
  const base = resource?.name ?? pane.title;
  if (pane.title && pane.title !== base) {
    return pane.title;
  }
  return base;
}
