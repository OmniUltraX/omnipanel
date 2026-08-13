import type { SftpPanelAdapter } from "../../components/sftp/sftpAdapter";
import type { SftpEntry } from "../../components/sftp/sftpUtils";
import { commands } from "../../ipc/bindings";
import type { DockerConnectionSource, DockerFileEntry } from "../../ipc/bindings";
import { unwrapCommand } from "../../ipc/result";

const unwrap = unwrapCommand;

function toSftpEntry(entry: DockerFileEntry): SftpEntry {
  return {
    name: entry.name,
    isDir: entry.isDir,
    isSymlink: entry.isSymlink,
    linkTarget: null,
    size: entry.sizeBytes ?? 0,
  };
}

const READONLY_CAPABILITIES = {
  mkdir: false,
  delete: false,
  rename: false,
  chmod: false,
} as const;

export function makeDockerContainerSftpAdapter(
  connectionId: string,
  containerId: string,
  source: DockerConnectionSource,
): SftpPanelAdapter {
  // 1Panel：/containers/files/search|content 支持只读列出与预览；写入仍依赖 SSH，暂不开放。
  const canWrite = source !== "one-panel";
  const canPreview = true;

  return {
    capabilities: {
      ...READONLY_CAPABILITIES,
      preview: canPreview,
    },
    list: async (path) => {
      const entries = await unwrap(
        commands.dockerListContainerDir(connectionId, containerId, path),
      );
      const normalized = entries.map(toSftpEntry);
      normalized.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return normalized;
    },
    readBytes: async (path, maxBytes) =>
      unwrap(commands.dockerReadContainerFile(connectionId, containerId, path, maxBytes)),
    writeBytes: canWrite
      ? async (path, bytes) => {
          await unwrap(
            commands.dockerWriteContainerFile(connectionId, containerId, path, bytes),
          );
        }
      : undefined,
  };
}
