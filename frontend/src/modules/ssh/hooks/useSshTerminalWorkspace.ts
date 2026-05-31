import { useCallback, useEffect, useMemo, useState } from "react";
import type { WorkspaceResource } from "../../../lib/resourceRegistry";
import {
  useSplitTerminalWorkspace,
  type SplitTerminalPaneInput,
} from "../../../components/terminal/split-workspace";
import {
  sshEmbeddedWorkspaceId,
  useTerminalStore,
} from "../../../stores/terminalStore";
import { disposePaneBackendSession } from "../../../hooks/useTerminal";
import { listSshEmbeddedPanes } from "../terminal/sshEmbeddedPanes";
import type { LayoutNode } from "../../terminal/splitLayout";

function disposeWorkspacePanes(workspaceId: string, resourceId: string) {
  const removeEmbeddedPane = useTerminalStore.getState().removeEmbeddedPane;
  for (const pane of listSshEmbeddedPanes(workspaceId, resourceId)) {
    disposePaneBackendSession(pane.id);
    removeEmbeddedPane(pane.id);
  }
}

/** SSH 详情内嵌终端：按主机管理工作区窗格与拆分布局（与顶部终端 Tab 隔离） */
export function useSshTerminalWorkspace(resource: WorkspaceResource | null) {
  const upsertEmbeddedPane = useTerminalStore((s) => s.upsertEmbeddedPane);
  const removeEmbeddedPane = useTerminalStore((s) => s.removeEmbeddedPane);
  const embeddedPanes = useTerminalStore((s) => s.embeddedPanes);

  const workspaceId = useMemo(
    () => (resource ? sshEmbeddedWorkspaceId(resource.id) : null),
    [resource?.id],
  );

  const [layout, setLayout] = useState<LayoutNode | null>(null);
  const [activePaneId, setActivePaneId] = useState<string | null>(null);

  const workspacePanes = useMemo(() => {
    if (!workspaceId || !resource) return [];
    return listSshEmbeddedPanes(workspaceId, resource.id);
  }, [embeddedPanes, resource?.id, workspaceId]);

  useEffect(() => {
    if (!resource || !workspaceId) {
      setLayout(null);
      setActivePaneId(null);
      return;
    }

    let panes = listSshEmbeddedPanes(workspaceId, resource.id);
    if (panes.length === 0) {
      upsertEmbeddedPane({
        id: workspaceId,
        title: resource.name,
        type: "remote",
        resourceId: resource.id,
        shellLabel: "SSH",
        cwd: "~/",
        purpose: "SSH Module Terminal",
        commandPack: [],
      });
      panes = listSshEmbeddedPanes(workspaceId, resource.id);
    }

    setActivePaneId((prev) =>
      prev && panes.some((pane) => pane.id === prev)
        ? prev
        : (panes[0]?.id ?? null),
    );
  }, [resource, workspaceId, upsertEmbeddedPane]);

  useEffect(() => {
    if (!resource || !workspaceId) return;
    const resourceId = resource.id;
    return () => {
      disposeWorkspacePanes(workspaceId, resourceId);
    };
  }, [resource?.id, workspaceId]);

  const onAddPane = useCallback(
    (pane: SplitTerminalPaneInput) => {
      upsertEmbeddedPane(pane);
    },
    [upsertEmbeddedPane],
  );

  const onRemovePane = useCallback(
    (paneId: string) => {
      disposePaneBackendSession(paneId);
      removeEmbeddedPane(paneId);
    },
    [removeEmbeddedPane],
  );

  const split = useSplitTerminalWorkspace({
    workspaceId: workspaceId ?? "__ssh_inactive__",
    panes: workspacePanes,
    activePaneId,
    onActivePaneChange: setActivePaneId,
    onAddPane,
    onRemovePane,
    layout,
    setLayout,
  });

  return {
    ...split,
    activePaneId,
    workspacePanes,
  };
}

export { listSshEmbeddedPanes } from "../terminal/sshEmbeddedPanes";
