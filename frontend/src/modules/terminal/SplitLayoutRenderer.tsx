import type { ReactNode } from "react";
import { DockLayout, DockPanel, DockHandle } from "../../components/dock";
import type { TerminalPane } from "../../stores/terminalStore";
import type { WorkspaceResource } from "../../lib/resourceRegistry";
import { TerminalPaneView } from "./TerminalPaneView";
import type { PaneServerOption } from "./PaneServerSelector";
import {
  isSplitContainer,
  normalizeSizes,
  type LayoutNode,
  type SplitDirection,
} from "./splitLayout";

export type SplitLayoutRendererProps = {
  node: LayoutNode;
  paneMap: Map<string, TerminalPane>;
  activePaneId: string | null;
  resourceMap: Map<string, WorkspaceResource | null>;
  serverOptions?: PaneServerOption[];
  occupiedResourceIds?: Set<string>;
  onPaneResourceChange?: (paneId: string, resourceId: string) => void;
  paneStartup?: (pane: TerminalPane) => string[];
  onActivatePane: (paneId: string) => void;
  onSendCommand: (command: string, paneId: string) => void;
  onSenderChange: (
    sessionId: string,
    sender: ((cmd: string) => void) | null,
  ) => void;
  onSplitPane: (paneId: string, direction: SplitDirection) => void;
  onClosePane: (paneId: string) => void;
  totalPanes: number;
  dockClassName?: string;
};

export function SplitLayoutRenderer({
  node,
  paneMap,
  activePaneId,
  resourceMap,
  serverOptions,
  occupiedResourceIds,
  onPaneResourceChange,
  paneStartup,
  onActivatePane,
  onSendCommand,
  onSenderChange,
  onSplitPane,
  onClosePane,
  totalPanes,
  dockClassName = "term-split-dock",
}: SplitLayoutRendererProps) {
  if (!isSplitContainer(node)) {
    const pane = paneMap.get(node.paneId);
    if (!pane) return null;
    const resource = resourceMap.get(node.paneId) ?? null;

    return (
      <TerminalPaneView
        paneId={node.paneId}
        resource={resource}
        pane={pane}
        isActive={node.paneId === activePaneId}
        startup={paneStartup?.(pane) ?? []}
        onActivate={() => onActivatePane(node.paneId)}
        onSendCommand={(cmd) => onSendCommand(cmd, node.paneId)}
        onSenderChange={onSenderChange}
        onSplitHorizontal={() => onSplitPane(node.paneId, "horizontal")}
        onSplitVertical={() => onSplitPane(node.paneId, "vertical")}
        onClose={() => onClosePane(node.paneId)}
        canClose={totalPanes > 1}
        serverOptions={serverOptions}
        occupiedResourceIds={occupiedResourceIds}
        onServerChange={
          onPaneResourceChange
            ? (resourceId) => onPaneResourceChange(node.paneId, resourceId)
            : undefined
        }
      />
    );
  }

  const direction = node.direction;
  const sizes = normalizeSizes(node.sizes, node.children.length);

  const dockChildren: ReactNode[] = [];
  node.children.forEach((child, index) => {
    if (index > 0) {
      dockChildren.push(
        <DockHandle
          key={`${node.id}-handle-${index}`}
          direction={direction}
        />,
      );
    }
    const panelKey = isSplitContainer(child) ? child.id : child.paneId;
    dockChildren.push(
      <DockPanel
        key={`${node.id}-panel-${panelKey}`}
        defaultSize={sizes[index]}
        minSize={10}
        onResize={() => {
          requestAnimationFrame(() => {
            window.dispatchEvent(new Event("resize"));
          });
        }}
      >
        <SplitLayoutRenderer
          node={child}
          paneMap={paneMap}
          activePaneId={activePaneId}
          resourceMap={resourceMap}
          serverOptions={serverOptions}
          occupiedResourceIds={occupiedResourceIds}
          onPaneResourceChange={onPaneResourceChange}
          paneStartup={paneStartup}
          onActivatePane={onActivatePane}
          onSendCommand={onSendCommand}
          onSenderChange={onSenderChange}
          onSplitPane={onSplitPane}
          onClosePane={onClosePane}
          totalPanes={totalPanes}
          dockClassName={dockClassName}
        />
      </DockPanel>,
    );
  });

  return (
    <DockLayout direction={direction} className={dockClassName}>
      {dockChildren}
    </DockLayout>
  );
}
