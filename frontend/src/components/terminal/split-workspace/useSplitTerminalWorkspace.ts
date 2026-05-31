import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { TerminalPane } from "../../../stores/terminalStore";
import {
  createPaneNode,
  createUniquePaneId,
  findPaneNode,
  findParentOfPane,
  generateSplitId,
  isSplitContainer,
  normalizeSizes,
  removePaneNode,
  updateNode,
  updatePaneNode,
  type LayoutNode,
  type SplitContainer,
  type SplitDirection,
} from "../../../modules/terminal/splitLayout";

export type SplitTerminalPaneInput = Omit<
  TerminalPane,
  "terminal" | "status" | "backendSessionId"
>;

export type UseSplitTerminalWorkspaceOptions = {
  /** 工作区 id，用于生成唯一窗格 id（tab id 或 ssh-embed:hostId） */
  workspaceId: string;
  panes: TerminalPane[];
  activePaneId: string | null;
  onActivePaneChange: (paneId: string) => void;
  onAddPane: (pane: SplitTerminalPaneInput) => void;
  onRemovePane: (paneId: string) => void;
  /** 命令已通过 PTY 发送后的可选副作用（如记入 action 队列） */
  onCommandExecuted?: (
    command: string,
    paneId: string,
    pane: TerminalPane,
  ) => void;
  layout: LayoutNode | null;
  setLayout: Dispatch<SetStateAction<LayoutNode | null>>;
};

export function useSplitTerminalWorkspace({
  workspaceId,
  panes,
  activePaneId,
  onActivePaneChange,
  onAddPane,
  onRemovePane,
  onCommandExecuted,
  layout,
  setLayout,
}: UseSplitTerminalWorkspaceOptions) {
  const paneSendersRef = useRef<Record<string, (cmd: string) => void>>({});
  const onActivePaneChangeRef = useRef(onActivePaneChange);
  onActivePaneChangeRef.current = onActivePaneChange;

  const paneIdsKey = panes.map((pane) => pane.id).join("\n");

  useEffect(() => {
    if (paneIdsKey === "") {
      setLayout(null);
      return;
    }

    const paneIds = paneIdsKey.split("\n");

    setLayout((prev) => {
      if (prev) return prev;
      return createPaneNode(paneIds[0]);
    });

    const firstPaneId = paneIds[0];
    if (
      activePaneId &&
      !paneIds.includes(activePaneId) &&
      firstPaneId
    ) {
      onActivePaneChangeRef.current(firstPaneId);
    }
  }, [workspaceId, paneIdsKey, activePaneId, setLayout]);

  const handlePaneSenderChange = useCallback(
    (sessionId: string, sender: ((cmd: string) => void) | null) => {
      if (sender) {
        paneSendersRef.current[sessionId] = sender;
        return;
      }
      delete paneSendersRef.current[sessionId];
    },
    [],
  );

  const handleCommand = useCallback(
    (command: string, paneId: string) => {
      paneSendersRef.current[paneId]?.(command);
      const pane = panes.find((item) => item.id === paneId);
      if (pane && onCommandExecuted) {
        onCommandExecuted(command, paneId, pane);
      }
    },
    [onCommandExecuted, panes],
  );

  const handleActivatePane = useCallback(
    (paneId: string) => {
      onActivePaneChange(paneId);
    },
    [onActivePaneChange],
  );

  const handleSplitPane = useCallback(
    (paneId: string, direction: SplitDirection) => {
      const sourcePane = panes.find((pane) => pane.id === paneId);
      if (!sourcePane) return;

      const newPaneId = createUniquePaneId(workspaceId, panes);

      setLayout((prev) => {
        if (!prev) return prev;
        if (!findPaneNode(prev, paneId)) return prev;

        const parent = findParentOfPane(prev, paneId);
        if (parent && parent.direction === direction) {
          const index = parent.children.findIndex(
            (child) => !isSplitContainer(child) && child.paneId === paneId,
          );
          if (index < 0) return prev;

          const newChildren = [...parent.children];
          newChildren.splice(index + 1, 0, createPaneNode(newPaneId));
          const newSizes = normalizeSizes(
            [...parent.sizes],
            newChildren.length,
          );

          return updateNode(prev, parent.id, () => ({
            ...parent,
            children: newChildren,
            sizes: newSizes,
          }));
        }

        const newSplit: SplitContainer = {
          id: generateSplitId(),
          type: "split",
          direction,
          children: [createPaneNode(paneId), createPaneNode(newPaneId)],
          sizes: [50, 50],
        };

        return updatePaneNode(prev, paneId, () => newSplit);
      });

      onAddPane({
        id: newPaneId,
        title: `${sourcePane.title} (${panes.length + 1})`,
        type: sourcePane.type,
        resourceId: sourcePane.resourceId,
        shellLabel: sourcePane.shellLabel,
        cwd: sourcePane.cwd,
        purpose: sourcePane.purpose,
        commandPack: sourcePane.commandPack,
      });
      onActivePaneChange(newPaneId);
    },
    [onActivePaneChange, onAddPane, panes, setLayout, workspaceId],
  );

  const handleClosePane = useCallback(
    (paneId: string) => {
      if (panes.length <= 1) return;

      setLayout((prev) => {
        if (!prev) return prev;
        return removePaneNode(prev, paneId);
      });

      onRemovePane(paneId);

      if (activePaneId === paneId) {
        const remaining = panes.filter((pane) => pane.id !== paneId);
        const next = remaining[remaining.length - 1];
        if (next) onActivePaneChange(next.id);
      }
    },
    [
      activePaneId,
      onActivePaneChange,
      onRemovePane,
      panes,
      setLayout,
    ],
  );

  return {
    layout,
    handlePaneSenderChange,
    handleCommand,
    handleActivatePane,
    handleSplitPane,
    handleClosePane,
  };
}
