import { invoke } from "@tauri-apps/api/core";
import { FilePreviewSubWindow } from "../files/FilePreviewSubWindow";
import type { FilePreviewIO } from "../files/FilePreviewContent";
import { readRemotePreview, uploadRemote } from "../files/fileApi";
import {
  useTerminalFilePreviewStore,
  targetToFileEntry,
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

  if (!target) return null;
  return (
    <FilePreviewSubWindow
      open
      entry={targetToFileEntry(target)}
      connectionId={target.connectionId}
      onClose={close}
      customIO={buildCustomIO(target)}
    />
  );
}
