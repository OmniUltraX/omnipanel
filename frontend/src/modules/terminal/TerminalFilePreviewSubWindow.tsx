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
  const isLocal = sessionType === "local";
  const previewResourceId = isLocal ? null : target?.resourceId ?? null;
  const treeSession = useMemo(
    () =>
      target
        ? {
            sessionType: (target.sessionType ?? "remote") as "local" | "remote",
            connectionId: target.connectionId,
            resourceId: previewResourceId,
          }
        : null,
    [target?.sessionType, target?.connectionId, previewResourceId],
  );

  const customIO = useMemo(() => {
    if (!target) return undefined;
    return buildFilePreviewIO(
      previewIoSessionFromTarget({
        ...target,
        resourceId: previewResourceId,
      }),
    );
  }, [target?.sessionType, target?.connectionId, previewResourceId]);

  const handleSelectEntry = useCallback(
    (entry: FileEntry) => {
      if (!target) return;
      tryOpenTerminalFilePreview({
        connectionId: target.connectionId,
        absolutePath: entry.path,
        name: entry.name,
        resourceId: previewResourceId,
        sessionType,
        sizeBytes: entry.size,
      });
    },
    [target, sessionType, previewResourceId],
  );

  if (!target || !treeSession) return null;

  return (
    <FilePreviewSubWindow
      open
      entry={targetToFileEntry(target)}
      connectionId={target.connectionId}
      sshResourceId={previewResourceId ?? undefined}
      onClose={close}
      customIO={customIO}
      treeSession={treeSession}
      onSelectEntry={handleSelectEntry}
    />
  );
}
