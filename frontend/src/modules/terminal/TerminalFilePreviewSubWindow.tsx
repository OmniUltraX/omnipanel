import { useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FilePreviewSubWindow } from "../files/FilePreviewSubWindow";
import type { FilePreviewIO } from "../files/FilePreviewContent";
import { readRemotePreview, uploadRemote } from "../files/fileApi";
import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import type { FileEntry } from "../../ipc/bindings";
import {
  useTerminalFilePreviewStore,
  targetToFileEntry,
  tryOpenTerminalFilePreview,
  type TerminalFilePreviewTarget,
} from "./terminalFilePreviewStore";

async function readRemoteBytesSftp(id: string, path: string, maxBytes: number): Promise<number[]> {
  const all = await invoke<number[]>("sftp_download", { id, path });
  if (all.length <= maxBytes) return all;
  return all.slice(0, maxBytes);
}

async function writeRemoteBytesSftp(id: string, path: string, bytes: number[]): Promise<void> {
  await invoke("sftp_upload", { id, path, data: bytes });
}

function buildCustomIO(target: TerminalFilePreviewTarget): FilePreviewIO {
  const sessionType = target.sessionType ?? "remote";
  const resourceId = target.resourceId ?? null;

  if (sessionType === "remote" && resourceId) {
    return {
      readBytes: (path, maxBytes) => readRemoteBytesSftp(resourceId, path, maxBytes),
      writeBytes: (path, bytes) => writeRemoteBytesSftp(resourceId, path, bytes),
      probeMediaMeta: async (path) => {
        const probe = await unwrapCommand(commands.sftpProbeMedia(resourceId, path));
        return {
          durationSecs: probe.durationSecs,
          size: probe.size,
          posterUrl: probe.posterDataUrl,
        };
      },
      resolveMediaSrc: async (path) => {
        const stream = await unwrapCommand(commands.sftpOpenMediaStream(resourceId, path));
        return { url: stream.url, token: stream.token };
      },
      closeMediaStream: async (token) => {
        await unwrapCommand(commands.sftpCloseMediaStream(token));
      },
    };
  }
  // 本地：走 file_manager 通道（已经支持 LOCAL_CONNECTION_ID）
  return {
    readBytes: (path, maxBytes) => readRemotePreview(target.connectionId, path, maxBytes),
    writeBytes: (path, bytes) => uploadRemote(target.connectionId, path, bytes),
  };
}

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

  const customIO = useMemo(
    () => (target ? buildCustomIO(target) : undefined),
    [target?.sessionType, target?.connectionId, target?.resourceId],
  );

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
      onClose={close}
      customIO={customIO}
      showFileTree
      treeSession={treeSession}
      onSelectEntry={handleSelectEntry}
    />
  );
}
