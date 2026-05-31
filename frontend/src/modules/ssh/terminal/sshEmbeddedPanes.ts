import { useTerminalStore, type TerminalPane } from "../../../stores/terminalStore";

function isWorkspacePaneId(workspaceId: string, paneId: string) {
  return paneId === workspaceId || paneId.startsWith(`${workspaceId}-pane-`);
}

export function listSshEmbeddedPanes(
  workspaceId: string,
  resourceId: string,
): TerminalPane[] {
  const embedded = useTerminalStore.getState().embeddedPanes;
  return Object.values(embedded)
    .filter(
      (pane) =>
        pane.resourceId === resourceId &&
        isWorkspacePaneId(workspaceId, pane.id),
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}
