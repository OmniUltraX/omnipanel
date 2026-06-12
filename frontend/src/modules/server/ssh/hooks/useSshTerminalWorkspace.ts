import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceResource } from "../../../../lib/resourceRegistry";
import {
  sshEmbeddedWorkspaceId,
  useTerminalStore,
} from "../../../../stores/terminalStore";
import { disposePaneBackendSession } from "../../../../hooks/useTerminal";
import { listSshEmbeddedPanes } from "../terminal/sshEmbeddedPanes";

function disposeWorkspacePanes(workspaceId: string, resourceId: string) {
  const removeEmbeddedPane = useTerminalStore.getState().removeEmbeddedPane;
  for (const pane of listSshEmbeddedPanes(workspaceId, resourceId)) {
    disposePaneBackendSession(pane.id);
    removeEmbeddedPane(pane.id);
  }
}

export function useSshTerminalWorkspace(
  resource: WorkspaceResource | null,
  active = false,
) {
  const upsertEmbeddedPane = useTerminalStore((s) => s.upsertEmbeddedPane);
  const embeddedPanes = useTerminalStore((s) => s.embeddedPanes);

  const workspaceId = useMemo(
    () => (resource ? sshEmbeddedWorkspaceId(resource.id) : null),
    [resource?.id],
  );

  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const paneSendersRef = useRef<Record<string, (cmd: string) => void>>({});

  const workspacePanes = useMemo(() => {
    if (!workspaceId || !resource) return [];
    return listSshEmbeddedPanes(workspaceId, resource.id);
  }, [embeddedPanes, resource?.id, workspaceId]);

  const activePane = useMemo(
    () => workspacePanes.find((p) => p.id === activePaneId) ?? workspacePanes[0] ?? null,
    [workspacePanes, activePaneId],
  );

  useEffect(() => {
    if (!resource || !workspaceId || !active) return;

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
  }, [resource, workspaceId, active, upsertEmbeddedPane]);

  useEffect(() => {
    if (!resource || !workspaceId) return;
    const resourceId = resource.id;
    return () => {
      disposeWorkspacePanes(workspaceId, resourceId);
    };
  }, [resource?.id, workspaceId]);

  const handleSenderChange = useCallback(
    (sessionId: string, sender: ((cmd: string) => void) | null) => {
      if (sender) {
        paneSendersRef.current[sessionId] = sender;
      } else {
        delete paneSendersRef.current[sessionId];
      }
    },
    [],
  );

  const handleCommand = useCallback(
    (command: string) => {
      if (!activePane) return;
      paneSendersRef.current[activePane.id]?.(command);
    },
    [activePane],
  );

  const hasPaneSender = useCallback(
    (paneId: string) => Boolean(paneSendersRef.current[paneId]),
    [],
  );

  return {
    activePaneId,
    activePane,
    workspacePanes,
    handleSenderChange,
    handleCommand,
    hasPaneSender,
  };
}

export { listSshEmbeddedPanes } from "../terminal/sshEmbeddedPanes";
