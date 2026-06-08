import { useCallback, useMemo, type ReactNode } from "react";
import type { TerminalPane } from "../../../stores/terminalStore";
import type { WorkspaceResource } from "../../../lib/resourceRegistry";
import { SplitLayoutRenderer } from "../../../modules/terminal/SplitLayoutRenderer";
import type { PaneServerOption } from "../../../modules/terminal/PaneServerSelector";
import { isSplitContainer } from "../../../modules/terminal/splitLayout";
import type { LayoutNode } from "../../../modules/terminal/splitLayout";

export type SplitTerminalWorkspaceProps = {
  panes: TerminalPane[];
  layout: LayoutNode | null;
  activePaneId: string | null;
  /** 为 false 时暂停 xterm 激活态（保留后端会话），例如 SSH 切到其他子 Tab */
  interactionActive?: boolean;
  getResource: (pane: TerminalPane) => WorkspaceResource | null;
  serverOptions?: PaneServerOption[];
  onPaneResourceChange?: (paneId: string, resourceId: string) => void;
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

function getPaneIdsInOrder(node: LayoutNode): string[] {
  if (!isSplitContainer(node)) {
    return [node.paneId];
  }
  return node.children.flatMap(getPaneIdsInOrder);
}

function focusInputByIndex(index: number) {
  const panes = document.querySelectorAll<HTMLElement>(".term-pane-leaf");
  const target = panes[index];
  if (!target) return;
  const textarea = target.querySelector<HTMLTextAreaElement>(".term-cmd-textarea");
  textarea?.focus();
}

export function SplitTerminalWorkspace({
  panes,
  layout,
  activePaneId,
  interactionActive = true,
  getResource,
  serverOptions,
  onPaneResourceChange,
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
      map.set(pane.id, getResource(pane));
    }
    return map;
  }, [getResource, panes]);

  const paneIdOrder = useMemo(
    () => (layout ? getPaneIdsInOrder(layout) : []),
    [layout],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.altKey && /^[1-9]$/.test(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        const index = parseInt(e.key, 10) - 1;
        const paneId = paneIdOrder[index];
        if (!paneId) return;
        onActivatePane(paneId);
        focusInputByIndex(index);
      }
    },
    [onActivatePane, paneIdOrder],
  );

  if (!layout || panes.length === 0) {
    return empty ?? null;
  }

  const effectiveActivePaneId = interactionActive ? activePaneId : null;

  return (
    <div className={className} tabIndex={0} onKeyDown={handleKeyDown}>
      <div className="term-panes">
        <SplitLayoutRenderer
          node={layout}
          paneMap={paneMap}
          activePaneId={effectiveActivePaneId}
          resourceMap={resourceMap}
          serverOptions={serverOptions}
          onPaneResourceChange={onPaneResourceChange}
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
