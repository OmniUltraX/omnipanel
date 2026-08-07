import { commands } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";
import { readRemotePreview, uploadRemote } from "./fileApi";
import type { FilePreviewIO } from "./FilePreviewContent";
import { LOCAL_CONNECTION_ID } from "./utils";

export type PreviewIoKind = "local" | "file_manager" | "sftp";

export type PreviewIoSession = {
  kind: PreviewIoKind;
  /**
   * local / file_manager：file_connections id（本地为 LOCAL_CONNECTION_ID）
   * sftp：通常等于 resourceId，供标题栏等展示
   */
  connectionId: string;
  /** sftp 资源 id；大日志 / 媒体流 / 压缩包依赖 */
  resourceId?: string | null;
};

/**
 * 按会话构建标准 FilePreviewIO，供文件管理 / SFTP / 终端等入口复用。
 */
export function buildFilePreviewIO(session: PreviewIoSession): FilePreviewIO {
  if (session.kind === "sftp") {
    const resourceId = session.resourceId?.trim();
    if (!resourceId) {
      throw new Error("sftp preview requires resourceId");
    }
    return buildSftpPreviewIO(resourceId);
  }

  const connectionId =
    session.kind === "local" ? LOCAL_CONNECTION_ID : session.connectionId;
  return {
    readBytes: (path, maxBytes) => readRemotePreview(connectionId, path, maxBytes),
    writeBytes: (path, bytes) => uploadRemote(connectionId, path, bytes),
  };
}

export function buildSftpPreviewIO(resourceId: string): FilePreviewIO {
  return {
    sshResourceId: resourceId,
    readBytes: async (path, maxBytes) => {
      const bytes = await unwrapCommand(commands.sftpDownload(resourceId, path));
      if (maxBytes > 0 && bytes.length > maxBytes) return bytes.slice(0, maxBytes);
      return bytes;
    },
    writeBytes: async (path, bytes) => {
      await unwrapCommand(commands.sftpUpload(resourceId, path, Array.from(bytes)));
    },
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
    listArchiveEntries: (path) =>
      unwrapCommand(commands.sshPoolListArchiveEntries(resourceId, path)),
    installArchiveTool: (tool) =>
      unwrapCommand(commands.sshPoolInstallArchiveTool(resourceId, tool)),
  };
}

/** 终端 / 本地预览 store 用：remote+resourceId → sftp，否则 local/file_manager */
export function previewIoSessionFromTarget(input: {
  sessionType?: "local" | "remote";
  connectionId: string;
  resourceId?: string | null;
}): PreviewIoSession {
  if (input.sessionType === "remote" && input.resourceId) {
    return {
      kind: "sftp",
      connectionId: input.connectionId,
      resourceId: input.resourceId,
    };
  }
  if (input.connectionId === LOCAL_CONNECTION_ID || input.sessionType === "local") {
    return { kind: "local", connectionId: LOCAL_CONNECTION_ID };
  }
  return { kind: "file_manager", connectionId: input.connectionId };
}
