import { useCallback, useMemo } from "react";
import { FilePreviewSubWindow } from "../files/FilePreviewSubWindow";
import { buildFilePreviewIO, previewIoSessionFromTarget } from "../files/previewIo";
import type { FileEntry } from "../../ipc/bindings";
import {
  useTerminalFilePreviewStore,
  targetToFileEntry,
  tryOpenTerminalFilePreview,
} from "./terminalFilePreviewStore";

export function TerminalFilePreviewSubWindow() {
  const target = useTerminalFilePreviewStore((s) => s.target);
  const close = useTerminalFilePreviewStore((s) => s.close);

  const sessionType = target?.sessionType ?? "remote";
  const treeSession = useMemo(
    () =>
      target
        ? {
            sessionType: (target.sessionType ?? "remote") as "local" | "remote",
            connectionId: target.connectionId,
            resourceId: target.resourceId ?? null,
          }
        : null,
    [target?.sessionType, target?.connectionId, target?.resourceId],
  );

  const customIO = useMemo(() => {
    if (!target) return undefined;
    return buildFilePreviewIO(previewIoSessionFromTarget(target));
  }, [target?.sessionType, target?.connectionId, target?.resourceId]);

  const handleSelectEntry = useCallback(
    (entry: FileEntry) => {
      if (!target) return;
      tryOpenTerminalFilePreview({
        connectionId: target.connectionId,
        absolutePath: entry.path,
        name: entry.name,
        resourceId: target.resourceId,
        sessionType,
        sizeBytes: entry.size,
      });
    },
    [target, sessionType],
  );

  if (!target || !treeSession) return null;

  return (
    <FilePreviewSubWindow
      open
      entry={targetToFileEntry(target)}
      connectionId={target.connectionId}
      sshResourceId={target.resourceId ?? undefined}
      onClose={close}
      customIO={customIO}
      treeSession={treeSession}
      onSelectEntry={handleSelectEntry}
    />
  );
}
