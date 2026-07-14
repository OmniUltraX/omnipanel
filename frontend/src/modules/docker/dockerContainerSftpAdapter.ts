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
  const canReadWrite = source !== "one-panel";

  return {
    capabilities: {
      ...READONLY_CAPABILITIES,
      preview: canReadWrite,
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
    readBytes: canReadWrite
      ? async (path, maxBytes) =>
          unwrap(
            commands.dockerReadContainerFile(connectionId, containerId, path, maxBytes),
          )
      : undefined,
    writeBytes: canReadWrite
      ? async (path, bytes) => {
          await unwrap(
            commands.dockerWriteContainerFile(connectionId, containerId, path, bytes),
          );
        }
      : undefined,
  };
}
