import { useMemo, type ReactNode } from "react";
import type { TerminalPane } from "../../../stores/terminalStore";
import type { WorkspaceResource } from "../../../lib/resourceRegistry";
import { SplitLayoutRenderer } from "../../../modules/terminal/SplitLayoutRenderer";
import type { LayoutNode } from "../../../modules/terminal/splitLayout";

export type SplitTerminalWorkspaceProps = {
  panes: TerminalPane[];
  layout: LayoutNode | null;
  activePaneId: string | null;
  /** 为 false 时暂停 xterm 激活态（保留后端会话），例如 SSH 切到其他子 Tab */
  interactionActive?: boolean;
  getResource: (pane: TerminalPane) => WorkspaceResource | null;
  paneStartup?: (pane: TerminalPane) => string[];
  onActivatePane: (paneId: string) => void;
  onSendCommand: (command: string, paneId: string) => void;
  onSenderChange: (
    sessionId: string,
    sender: ((cmd: string) => void) | null,
  ) => void;
  onSplitPane: (paneId: string, direction: "horizontal" | "vertical") => void;
  onClosePane: (paneId: string) => void;
  className?: string;
  dockClassName?: string;
  empty?: ReactNode;
};

export function SplitTerminalWorkspace({
  panes,
  layout,
  activePaneId,
  interactionActive = true,
  getResource,
  paneStartup,
  onActivatePane,
  onSendCommand,
  onSenderChange,
  onSplitPane,
  onClosePane,
  className = "term-workspace",
  dockClassName = "term-split-dock",
  empty,
}: SplitTerminalWorkspaceProps) {
  const paneMap = useMemo(
    () => new Map(panes.map((pane) => [pane.id, pane])),
    [panes],
  );

  const resourceMap = useMemo(() => {
    const map = new Map<string, WorkspaceResource | null>();
    for (const pane of panes) {
      map.set(pane.resourceId, getResource(pane));
    }
    return map;
  }, [getResource, panes]);

  if (!layout || panes.length === 0) {
    return empty ?? null;
  }

  const effectiveActivePaneId = interactionActive ? activePaneId : null;

  return (
    <div className={className}>
      <div className="term-panes">
        <SplitLayoutRenderer
          node={layout}
          paneMap={paneMap}
          activePaneId={effectiveActivePaneId}
          resourceMap={resourceMap}
          paneStartup={paneStartup}
          onActivatePane={onActivatePane}
          onSendCommand={onSendCommand}
          onSenderChange={onSenderChange}
          onSplitPane={onSplitPane}
          onClosePane={onClosePane}
          totalPanes={panes.length}
          dockClassName={dockClassName}
        />
      </div>
    </div>
  );
}
